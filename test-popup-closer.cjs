'use strict';
// 零依赖逻辑测试：用模拟 DOM 验证选择、状态机与限流。不是 Chrome 或真实 PDD 测试。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'pdd-popup-closer.user.js'), 'utf8');

function env({ pathname = '/home/', enabled = true } = {}) {
    let now = 100000;
    let nextId = 1;
    const timers = new Map();
    const intervals = new Map();
    const menus = new Map();
    const events = new Map();
    const logs = [];
    const svgs = [];
    let observer;
    const style = { display: 'block', visibility: 'visible', opacity: '1' };
    class Element {
        constructor(classes = [], parent = null, attrs = {}) {
            this.classList = classes;
            this.parentElement = parent;
            this.attrs = attrs;
            this.style = { ...style };
            this.isConnected = true;
            this.hidden = false;
            this.inert = false;
            this.disabled = false;
            this.blocked = false;
            this.clicks = 0;
            this.rect = { left: 10, top: 10, right: 40, bottom: 40 };
        }
        getAttribute(key) { return this.attrs[key] ?? null; }
        getClientRects() { return this.isConnected ? [this.rect] : []; }
        getBoundingClientRect() { return this.rect; }
        matches() { return this.disabled || this.attrs['aria-disabled'] === 'true'; }
        contains(other) {
            for (let n = other; n; n = n.parentElement) if (n === this) return true;
            return false;
        }
        click() { this.clicks++; if (this.onClick) this.onClick(); }
        dispatchEvent() { this.click(); return true; }
    }
    const root = new Element();
    const doc = {
        documentElement: root,
        querySelectorAll() {
            return svgs.filter(s => s.attrs['data-testid'] === 'beast-core-modal-icon-close' || s.classList.some(c => c.includes('MDL_headerCloseIcon') || c.includes('ImportantList_close') || c.includes('MDL_iconWrapper')));
        },
        elementFromPoint() {
            for (const s of [...svgs].reverse()) {
                let hidden = false;
                for (let n = s; n; n = n.parentElement) {
                    if (!n.isConnected || n.hidden || n.inert || n.style.display === 'none' || n.style.visibility === 'hidden' || Number(n.style.opacity) === 0) hidden = true;
                }
                if (!hidden) return s.parentElement.blocked ? root : s;
            }
            return null;
        },
        addEventListener(name, fn) { events.set(name, fn); },
    };
    const context = {
        document: doc,
        location: { hostname: 'mms.pinduoduo.com', pathname },
        innerWidth: 1000, innerHeight: 800,
        getComputedStyle: el => el.style,
        Date: { now: () => now },
        WeakMap, MouseEvent: class {},
        MutationObserver: class {
            constructor(fn) { this.fn = fn; observer = this; }
            observe() { this.active = true; }
            disconnect() { this.active = false; }
        },
        setTimeout(fn) { const id = nextId++; timers.set(id, fn); return id; },
        clearTimeout(id) { timers.delete(id); },
        setInterval(fn) { const id = nextId++; intervals.set(id, fn); return id; },
        clearInterval(id) { intervals.delete(id); },
        addEventListener(name, fn) { events.set(name, fn); },
        GM_getValue: () => enabled,
        GM_setValue: (_key, value) => { enabled = value; },
        GM_registerMenuCommand: (name, fn) => menus.set(name, fn),
        console: Object.fromEntries(['info', 'debug', 'warn', 'error'].map(k => [k, (...args) => logs.push([k, ...args])])),
    };
    context.window = context;
    vm.runInNewContext(source, context, { filename: 'pdd-popup-closer.user.js' });
    function popup({ suffix = '5-155-0', stable = true, icon = true, modalClass = true } = {}) {
        const modal = new Element(modalClass ? [`MDL_modal_${suffix}`] : ['ordinary'], root);
        const wrapper = new Element([`MDL_iconWrapper_${suffix}`], modal);
        const svg = new Element(icon ? [`MDL_headerCloseIcon_${suffix}`] : [], wrapper, stable ? { 'data-testid': 'beast-core-modal-icon-close' } : {});
        svgs.push(svg);
        return { modal, wrapper, svg };
    }
    function message({ suffix = 'd0eKb', id = 'umd-msgbox-handler', header = true, closeIcon = true } = {}) {
        const modal = new Element([], root, { id });
        const h = new Element(header ? ['ImportantList_msgbox-header__1hGG1'] : ['other'], modal);
        const wrapper = new Element([], h);
        const icon = new Element([`ImportantList_close__${suffix}`, ...(closeIcon ? ['Icon_umd-icon-close__FDu9I'] : [])], wrapper);
        svgs.push(icon);
        return { modal, wrapper, icon };
    }
    function flush(delta = 0) {
        now += delta;
        const batch = [...timers]; timers.clear();
        batch.forEach(([, fn]) => fn());
    }
    function tick(delta = 2000) {
        now += delta;
        [...intervals.values()].forEach(fn => fn());
        flush();
    }
    function mutate() { if (observer?.active) observer.fn([]); }
    function menu(prefix) { const item = [...menus].find(([name]) => name.startsWith(prefix)); assert.ok(item); item[1](); }
    return { popup, message, addCandidate: (node) => svgs.push(node), flush, tick, mutate, menu, events, logs, timers, intervals, context };
}

const results = [];
function test(name, fn) {
    try { fn(); results.push(`PASS ${name}`); }
    catch (error) { results.push(`FAIL ${name}: ${error.stack}`); process.exitCode = 1; }
}

test('用户提供的 testid 与外壳：仅点击外壳一次', () => {
    const e = env(); const p = e.popup(); e.flush();
    assert.equal(p.wrapper.clicks, 1); assert.equal(p.svg.clicks, 0);
});
test('版本号变化：无 testid 时按 class token 兜底', () => {
    const e = env(); const p = e.popup({ suffix: '9-999-12', stable: false }); e.flush(); assert.equal(p.wrapper.clicks, 1);
});
test('稳定 testid：图标 class 消失仍匹配', () => {
    const e = env(); const p = e.popup({ icon: false }); e.flush(); assert.equal(p.wrapper.clicks, 1);
});
test('不在 MDL_modal 容器内：不点击', () => {
    const e = env(); const p = e.popup({ modalClass: false }); e.flush(); assert.equal(p.wrapper.clicks, 0);
});
test('伪前缀 class：不误匹配', () => {
    const e = env(); const p = e.popup({ stable: false }); p.svg.classList = ['NOT_MDL_headerCloseIcon_5-155-0']; e.flush(); assert.equal(p.wrapper.clicks, 0);
});
test('隐藏 / 透明 / aria-hidden / inert：不点击', () => {
    for (const kind of ['hidden', 'opacity', 'aria', 'inert']) {
        const e = env(); const p = e.popup();
        if (kind === 'hidden') p.modal.hidden = true;
        if (kind === 'opacity') p.modal.style.opacity = '0';
        if (kind === 'aria') p.modal.attrs['aria-hidden'] = 'true';
        if (kind === 'inert') p.modal.inert = true;
        e.flush(); assert.equal(p.wrapper.clicks, 0);
    }
});
test('被遮挡 / 禁用 / 视口外：不点击', () => {
    for (const kind of ['blocked', 'disabled', 'offscreen']) {
        const e = env(); const p = e.popup();
        if (kind === 'blocked') p.wrapper.blocked = true;
        if (kind === 'disabled') p.wrapper.disabled = true;
        if (kind === 'offscreen') p.wrapper.rect = { left: -100, right: -50, top: 10, bottom: 30 };
        e.flush(); assert.equal(p.wrapper.clicks, 0);
    }
});
test('点击冷却与最多三次重试', () => {
    const e = env(); const p = e.popup(); e.flush(); e.flush(120); assert.equal(p.wrapper.clicks, 1);
    for (let i = 0; i < 5; i++) e.tick();
    assert.equal(p.wrapper.clicks, 3); assert.ok(e.logs.some(l => l[0] === 'warn'));
});
test('点击关闭后 DOM 消失：不会重复点击', () => {
    const e = env(); const p = e.popup(); p.wrapper.onClick = () => { p.modal.hidden = true; }; e.flush(); e.tick(); assert.equal(p.wrapper.clicks, 1);
});
test('动态添加：MutationObserver 触发扫描', () => {
    const e = env(); e.flush(); const p = e.popup(); e.mutate(); e.flush(); assert.equal(p.wrapper.clicks, 1);
});
test('属性变动：先隐藏后出现', () => {
    const e = env(); const p = e.popup(); p.modal.hidden = true; e.flush(); p.modal.hidden = false; e.mutate(); e.flush(); assert.equal(p.wrapper.clicks, 1);
});
test('堆叠弹窗：一轮仅点击最上层', () => {
    const e = env(); const a = e.popup(); const b = e.popup(); b.wrapper.onClick = () => { b.modal.hidden = true; };
    e.flush(); assert.equal(a.wrapper.clicks, 0); assert.equal(b.wrapper.clicks, 1);
    e.flush(120); assert.equal(a.wrapper.clicks, 1);
});
test('每分钟 12 次上限：第十三次熔断暂停', () => {
    const e = env(); const ps = Array.from({ length: 13 }, () => e.popup());
    ps.forEach(p => { p.wrapper.onClick = () => { p.modal.hidden = true; }; });
    for (let i = 0; i < 13; i++) e.flush(120);
    assert.equal(ps.reduce((sum, p) => sum + p.wrapper.clicks, 0), 12);
    assert.equal(e.intervals.size, 0); assert.ok(e.logs.some(l => String(l).includes('一分钟')));
});
test('暂停 / 启用：停止并恢复扫描', () => {
    const e = env(); const p = e.popup(); e.menu('暂停'); e.flush(); e.tick(); assert.equal(p.wrapper.clicks, 0);
    e.menu('启用'); e.flush(); assert.equal(p.wrapper.clicks, 1);
});
test('持久暂停：初始不开观察器与定时器', () => {
    const e = env({ enabled: false }); const p = e.popup(); e.flush(); assert.equal(p.wrapper.clicks, 0); assert.equal(e.intervals.size, 0);
});
test('后台全路径支持：订单页 / 其它路径 / SPA 切换', () => {
    for (const pathname of ['/orders/list', '/homepage', '/orders', '/home/']) {
        const e = env({ pathname }); const p = e.message(); e.flush(); assert.equal(p.icon.clicks, 1);
    }
    const e = env(); e.flush(); e.context.location.pathname = '/orders/list';
    const p = e.message(); e.mutate(); e.flush(); assert.equal(p.icon.clicks, 1);
});
test('pagehide 清理 / pageshow 恢复（BFCache）', () => {
    const e = env(); const p = e.popup(); e.events.get('pagehide')(); e.flush(); assert.equal(p.wrapper.clicks, 0); assert.equal(e.intervals.size, 0);
    e.events.get('pageshow')(); e.flush(); assert.equal(p.wrapper.clicks, 1);
});
test('连续变更合并：仅一个待执行扫描', () => {
    const e = env(); for (let i = 0; i < 100; i++) e.mutate(); assert.equal(e.timers.size, 1);
});
test('点击异常：记录错误并自动暂停', () => {
    const e = env(); const p = e.popup(); p.wrapper.onClick = () => { throw new Error('simulated'); }; e.flush();
    assert.equal(e.intervals.size, 0); assert.ok(e.logs.some(l => l[0] === 'error'));
});
test('UMD 新按钮：点击 i 本身，兼容动态哈希', () => {
    for (const suffix of ['d0eKb', 'newHash_123']) {
        const e = env(); const p = e.message({ suffix }); e.flush();
        assert.equal(p.icon.clicks, 1); assert.equal(p.wrapper.clicks, 0);
    }
});
test('UMD 容器 / 标题区 / 关闭图标三重约束', () => {
    for (const options of [{ id: 'other' }, { header: false }, { closeIcon: false }]) {
        const e = env(); const p = e.message(options); e.flush(); assert.equal(p.icon.clicks, 0);
    }
});
test('UMD 隐藏与有限重试', () => {
    const e = env(); const p = e.message(); p.modal.hidden = true; e.flush(); assert.equal(p.icon.clicks, 0);
    p.modal.hidden = false; e.mutate(); e.flush();
    for (let i = 0; i < 5; i++) e.tick(); assert.equal(p.icon.clicks, 3);
});
test('UMD 与原 Modal 共存：依次关闭', () => {
    const e = env(); const a = e.popup(); const b = e.message();
    b.icon.onClick = () => { b.modal.hidden = true; };
    e.flush(); assert.equal(b.icon.clicks, 1); assert.equal(a.wrapper.clicks, 0);
    e.flush(120); assert.equal(a.wrapper.clicks, 1);
});
test('Beast Alert 5-193-0：关闭外壳，无视 undefined class', () => {
    const e = env(); const p = e.popup({ suffix: '5-193-0' });
    p.modal.classList = ['MDL_outerWrapper_5-193-0', 'MDL_alert_5-193-0', 'MDL_showCloseIcon_5-193-0', 'undefined'];
    e.flush(); assert.equal(p.wrapper.clicks, 1);
});
test('Beast Alert 版本变化与仅外壳节点', () => {
    const e = env(); const p = e.popup({ suffix: '9-200-1' });
    p.modal.classList = ['MDL_alert_9-200-1'];
    p.svg.classList = []; p.svg.attrs = {};
    e.addCandidate(p.wrapper);
    e.flush(); assert.equal(p.wrapper.clicks, 1);
});
test('Alert 与 Modal 不重复点击：外壳与 SVG 同时入选', () => {
    const e = env(); const p = e.popup();
    p.modal.classList.push('MDL_alert_5-193-0');
    e.addCandidate(p.wrapper);
    e.flush(); e.flush(120); assert.equal(p.wrapper.clicks, 1);
});
const report = [
    'PDD 弹窗脚本测试报告',
    '日期：2026-10-10',
    '方法：Node.js vm + 手写模拟 DOM，零外部依赖；不是浏览器端到端测试。',
    '真实页面状态：本机 CDP 9222/9223/9333 连接超时，默认 Chrome/PDD 实页未验证。',
    '限制：未验证真实布局、React 事件处理、Tampermonkey 沙盒和菜单注入、isTrusted 限制。',
    '', ...results, '',
    `汇总：${results.filter(r => r.startsWith('PASS')).length}/${results.length} 通过`,
].join('\n');
fs.writeFileSync(path.join(__dirname, '测试报告.txt'), report, 'utf8');
console.log(report);
