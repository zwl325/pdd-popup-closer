# PDD 商家后台弹窗自动关闭

用于 Tampermonkey 的模块化用户脚本，辅助浏览器自动化处理已知弹窗关闭图标。

## 安装与更新

1. 安装 Tampermonkey。
2. 打开 [安装脚本（Raw）](https://raw.githubusercontent.com/zwl325/pdd-popup-closer/main/pdd-popup-closer.user.js)，确认安装；若浏览器未打开安装页，可使用 Tampermonkey 的“实用工具 → 从 URL 安装”导入此地址。
3. 启用脚本及更新检查，刷新 PDD 商家后台。

`@updateURL` 和 `@downloadURL` 指向本仓库 main 分支。每次发布必须增加 `@version`。更新按用户设置的检查周期进行，不是即时推送；已打开的后台页面需刷新。GitHub Raw 不可达时无法检查更新。

旧版本使用本地 file:// 更新源的用户，需要安装一次此远程更新源版本。之后无需反复复制代码。无需开启本地文件访问权限。

## 支持范围

匹配 `https://mms.pinduoduo.com/*`，包括 `/orders/list`。仅顶层文档，不处理 iframe 内或 Shadow DOM 内的弹窗。

- `beast-modal`：MDL_modal_* 内关闭按钮。
- `beast-alert`：MDL_alert_* 内关闭按钮。
- `umd-important-message`：#umd-msgbox-handler 标题区内 ImportantList_close__* + Icon_umd-icon-close__*。

版本号和 CSS Modules 哈希后缀使用 class token 正则匹配。每轮只点击一个目标，不隐藏或删除 DOM，不点击确认、提交按钮。

## 控制与安全边界

Tampermonkey 菜单提供暂停、恢复、查看统计、重置重试记录。暂停会持久化；已打开的其它标签页需单独暂停或刷新。

- DOM 变化合并扫描，2 秒定时兜底。
- 检查可见性、禁用、视口与中心点遮挡。
- 同一弹窗最多 3 次尝试，间隔至少 1.2 秒。
- 每分钟最多 12 次点击，超限自动暂停。
- 使用合成 click（isTrusted=false），不绕过网站的真实输入要求。

**关闭图标是通用组件，可能关闭正常业务弹窗，而不仅是广告。使用前评估对人工操作和自动化流程的影响。** 可通过 CONFIG.ALLOW_MODAL 或规则 allow(modal) 限定标题/内容白名单。统计只表示已发出点击，不保证关闭成功。

## 模块化维护

业务按钮集中维护在 RULES 注册表，通用引擎负责调度与执行。

每条规则包含：

- `id`：唯一标识。
- `enabled`：单条开关。
- `selector`：候选元素粗筛。
- `resolve(element)`：精确校验；返回 `{ modal, target }`，不匹配返回 null，不在这里点击。
- `allow(modal)`：可选白名单。

新增 Beast 类型可调用 makeBeastRule；其它类型增加独立规则。规则匹配器必须能安全地接收不属于该规则的候选元素。保持原 @name 和 @namespace 稳定。

## 测试与发布

使用 Node.js 运行：

```sh
node --check pdd-popup-closer.user.js
node test-popup-closer.cjs
```

目前 26 项零依赖 Node VM 模拟 DOM 测试通过，包含订单页与 SPA 路由。**尚未完成真实 Chrome/PDD 页面端到端验证**；模拟测试不验证浏览器布局、React 事件处理、Tampermonkey 沙盒或扩展更新链路。

发布前测试并提升版本号，然后提交到 main；main 为用户更新源，不应提交未经验证的实验改动。增加权限时可能需要用户确认。

## 许可证

[0BSD](LICENSE)：允许任何目的使用、复制、修改和分发，包括商业用途，无需署名或保留声明。软件按原样提供，不作担保。
