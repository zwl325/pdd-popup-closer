// ==UserScript==
// @name         PDD 商家主页弹窗自动关闭（自动化辅助）
// 保留原 @name / @namespace，避免自动更新时被识别为另一脚本；实际覆盖后台所有路径。
// @namespace    urn:workbuddy:pdd-popup-closer
// @version      2026.10.10.6
// @license      0BSD
// @homepageURL  https://github.com/zwl325/pdd-popup-closer
// @supportURL   https://github.com/zwl325/pdd-popup-closer/issues
// @updateURL    https://raw.githubusercontent.com/zwl325/pdd-popup-closer/main/pdd-popup-closer.user.js
// @downloadURL  https://raw.githubusercontent.com/zwl325/pdd-popup-closer/main/pdd-popup-closer.user.js
// @description  模块化关闭 PDD 后台 Beast Modal、Beast Alert 与 UMD 重要消息弹窗；动态后缀兼容、可见性检查、有限重试、限流与暂停菜单。
// @author       WorkBuddy
// @match        https://mms.pinduoduo.com/*
// @icon         https://mms.pinduoduo.com/favicon.ico
// @run-at       document-idle
// @noframes
// @sandbox      DOM
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    // 警告：这是通用 Modal 关闭图标，不代表弹窗一定是广告。
    // 默认会关闭符合规则的所有后台弹窗，正常业务弹窗也可能被关闭。
    // 需要精确白名单时，把 ALLOW_MODAL 改为按标题/内容返回 true 的函数。
    // 不隐藏/删除 DOM，不点确认/提交，不绕过验证码或权限校验。
    const CONFIG = Object.freeze({
        SCAN_DELAY_MS: 120,
        FALLBACK_INTERVAL_MS: 2000,
        RETRY_INTERVAL_MS: 1200,
        MAX_ATTEMPTS_PER_MODAL: 3,
        MAX_CLICKS_PER_MINUTE: 12,
        DEBUG: false,
        ALLOW_MODAL: (_modal) => true,
    });
    const PREFIX = '[PDD Popup Closer]';
    // === 通用匹配工具配置 ===
    const CLASS = {
        wrapper: /^MDL_iconWrapper(?:_[\w-]+)?$/,
        icon: /^MDL_headerCloseIcon(?:_[\w-]+)?$/,
        messageHeader: /^ImportantList_msgbox-header(?:__[\w-]+)?$/,
        messageClose: /^ImportantList_close(?:__[\w-]+)?$/,
        messageCloseIcon: /^Icon_umd-icon-close(?:__[\w-]+)?$/,
    };

    // === 规则模块注册表（以后新增按钮主要修改这里） ===
    // 契约：id 唯一；enabled 控制单条规则；selector 只负责粗筛；
    // resolve(element) 精确校验后返回 { modal: 弹窗根节点, target: 点击节点 }，
    // 不匹配时返回 null。resolve 内不要点击，所有动作由通用引擎执行。
    // 可选 allow(modal) 用于单条规则的标题/内容白名单。
    const RULES = [
        makeBeastRule('beast-modal', /^MDL_modal(?:_[\w-]+)?$/),
        makeBeastRule('beast-alert', /^MDL_alert(?:_[\w-]+)?$/),
        {
            id: 'umd-important-message',
            enabled: true,
            selector: '#umd-msgbox-handler i[class*="ImportantList_close"]',
            resolve(element) {
                if (!hasClass(element, CLASS.messageClose) || !hasClass(element, CLASS.messageCloseIcon)) return null;
                const header = ancestor(element, CLASS.messageHeader);
                if (!header) return null;
                for (let node = header.parentElement; node; node = node.parentElement) {
                    if (node.getAttribute('id') === 'umd-msgbox-handler') {
                        return { modal: node, target: element };
                    }
                }
                return null;
            },
        },
    ];
    const ACTIVE_RULES = RULES.filter((rule) => rule.enabled);
    const SELECTOR = [...new Set(ACTIVE_RULES.map((rule) => rule.selector))].join(',');

    // Beast Modal / Alert 共用匹配工厂；不绑定 5-155-0 / 5-193-0 等版本号。
    function makeBeastRule(id, containerPattern) {
        return {
            id,
            enabled: true,
            selector: 'svg[data-testid="beast-core-modal-icon-close"], svg[class*="MDL_headerCloseIcon"], div[class*="MDL_iconWrapper"]',
            resolve(element) {
                const isWrapper = hasClass(element, CLASS.wrapper);
                const isCloseIcon = element.getAttribute('data-testid') === 'beast-core-modal-icon-close' || hasClass(element, CLASS.icon);
                if (!isWrapper && !isCloseIcon) return null;
                const modal = ancestor(element, containerPattern);
                if (!modal) return null;
                // 允许用户直接提供 iconWrapper（不要求一定存在 svg）。
                // 包含 class="undefined" 的父节点不会影响匹配。
                const wrapper = ancestor(element, CLASS.wrapper);
                const target = wrapper && modal.contains(wrapper) ? wrapper : element;
                return { modal, target };
            },
        };
    }
    let enabled = GM_getValue('enabled', true) !== false;
    let fuseTripped = false;
    let running = false;
    let scheduled = null;
    let interval = null;
    let observer = null;
    let attempts = new WeakMap();
    let clickTimes = [];
    const stats = { clicksDispatched: 0, exhaustedModals: 0 };

    function hasClass(element, pattern) {
        return element && Array.from(element.classList).some((name) => pattern.test(name));
    }

    function ancestor(element, pattern) {
        for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
            if (hasClass(node, pattern)) return node;
        }
        return null;
    }

    function onMerchantSite() {
        return location.hostname === 'mms.pinduoduo.com';
    }

    function visible(element) {
        if (!element || !element.isConnected || !element.getClientRects().length) return false;
        for (let node = element; node; node = node.parentElement) {
            if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true') return false;
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
        }
        return true;
    }

    function clickable(target) {
        if (!visible(target) || target.matches('[disabled], [aria-disabled="true"]')) return false;
        const rect = target.getBoundingClientRect();
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(innerWidth, rect.right);
        const bottom = Math.min(innerHeight, rect.bottom);
        if (right <= left || bottom <= top) return false;
        const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        // 防止点击被其它遮罩挡住的弹窗或堆叠弹窗的底层关闭按钮。
        return !!hit && (hit === target || target.contains(hit));
    }

    // === 通用扫描引擎：不包含具体业务按钮判断 ===
    function candidate(element) {
        for (const rule of ACTIVE_RULES) {
            const item = rule.resolve(element);
            if (item && (!rule.allow || rule.allow(item.modal))) {
                return { ...item, ruleId: rule.id };
            }
        }
        return null;
    }

    function scan() {
        if (!running || !enabled || fuseTripped || !onMerchantSite()) return;
        const now = Date.now();
        if (!SELECTOR) return;
        const seenTargets = new Set();
        for (const element of document.querySelectorAll(SELECTOR)) {
            const item = candidate(element);
            if (item && seenTargets.has(item.target)) continue;
            if (item) seenTargets.add(item.target);
            if (!item) continue;
            const { modal, target } = item;
            if (!visible(modal)) {
                // 同一 DOM 隐藏后再次展示，可作为新一轮弹窗有限重试。
                attempts.delete(modal);
                continue;
            }
            if (!CONFIG.ALLOW_MODAL(modal) || !clickable(target)) continue;
            const record = attempts.get(modal) || { count: 0, last: 0, warned: false };
            if (record.count >= CONFIG.MAX_ATTEMPTS_PER_MODAL) {
                if (!record.warned) {
                    record.warned = true;
                    stats.exhaustedModals++;
                    console.warn(PREFIX, '同一弹窗点击三次后仍匹配，停止重试。可通过菜单查看统计/重置。');
                }
                continue;
            }
            if (record.count > 0 && now - record.last < CONFIG.RETRY_INTERVAL_MS) continue;
            clickTimes = clickTimes.filter((time) => now - time < 60000);
            if (clickTimes.length >= CONFIG.MAX_CLICKS_PER_MINUTE) {
                fuseTripped = true;
                stop();
                console.warn(PREFIX, '一分钟达到点击上限，自动暂停。请检查是否发生弹窗循环后再从菜单恢复。');
                return;
            }
            record.count++;
            record.last = now;
            attempts.set(modal, record);
            clickTimes.push(now);
            // 仅发出一次 click，不拼凑多组 mouse/pointer 事件，避免重复触发。
            // 合成点击 isTrusted=false；网站若强制要求真实输入，本脚本不会绕过。
            if (typeof target.click === 'function') target.click();
            else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            stats.clicksDispatched++;
            if (CONFIG.DEBUG) console.debug(PREFIX, '已发出关闭点击（非关闭成功断言）', item.ruleId, record.count);
            // 每轮只点击一个，等待 React 状态与遮罩更新再处理下一个。
            schedule();
            return;
        }
    }

    function safeScan() {
        scheduled = null;
        try { scan(); }
        catch (error) {
            fuseTripped = true;
            stop();
            console.error(PREFIX, '发生异常，已暂停。', error);
        }
    }

    function schedule() {
        // 固定窗口合并，而非不断清零的 debounce；持续 DOM 变化不会饿死扫描。
        if (running && scheduled === null) scheduled = setTimeout(safeScan, CONFIG.SCAN_DELAY_MS);
    }

    function start() {
        if (running || !enabled || fuseTripped) return;
        running = true;
        observer = new MutationObserver(schedule);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'aria-disabled', 'disabled', 'data-testid'],
        });
        // 兜底：动画结束、无 DOM 变化、SPA 路由变化、后台标签页恢复。
        interval = setInterval(schedule, CONFIG.FALLBACK_INTERVAL_MS);
        schedule();
    }

    function stop() {
        running = false;
        if (observer) observer.disconnect();
        observer = null;
        if (scheduled !== null) clearTimeout(scheduled);
        if (interval !== null) clearInterval(interval);
        scheduled = null;
        interval = null;
    }

    function reset() {
        attempts = new WeakMap();
        clickTimes = [];
        fuseTripped = false;
    }

    GM_registerMenuCommand('暂停自动关闭（刷新后仍暂停）', () => {
        enabled = false;
        GM_setValue('enabled', false);
        stop();
        console.info(PREFIX, '已暂停；其它已打开标签页需分别暂停或刷新。');
    });
    GM_registerMenuCommand('启用 / 解除限流暂停', () => {
        enabled = true;
        GM_setValue('enabled', true);
        reset();
        start();
        console.info(PREFIX, '已启用。');
    });
    GM_registerMenuCommand('查看状态与点击统计（控制台）', () => {
        console.info(PREFIX, { enabled, running, fuseTripped, onMerchantSite: onMerchantSite(), ...stats });
    });
    GM_registerMenuCommand('重置重试记录并重新扫描', () => {
        reset();
        start();
        schedule();
    });
    addEventListener('pagehide', stop);
    addEventListener('pageshow', start);
    document.addEventListener('visibilitychange', schedule);
    start();
})();
