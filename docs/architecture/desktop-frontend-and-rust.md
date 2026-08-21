# 桌面前端与 Rust 长期架构

## 状态

ADR-0030 确定桌面端只维护一套产品 UI。当前唯一可视实现位于 `ui/`；`apps/desktop-ui/` 只承载无视图 TypeScript 业务边界和 Vite 构建的阅读协议/PDF adapter。

## 技术边界

| 范围 | 选择 | 说明 |
| --- | --- | --- |
| 桌面业务 UI | `ui/` 的 HTML/CSS/JavaScript | 所有业务页只有一份 DOM、样式和交互实现。 |
| 业务状态与边界 | 严格 TypeScript | state、rules、controller 和 port 可独立测试，不定义另一份页面。 |
| 阅读引擎 | 命令式 DOM/Canvas | EPUB/PDF、分页、选区、手势与高频渲染保持独立引擎边界。 |
| 桌面原生层 | Rust + Tauri 2 | 窗口、菜单、文件、数据库、同步、系统集成和高耗时任务留在 Rust。 |
| 新建独立 Rust HTTP 服务 | Axum + Tokio（需要时） | 只适用于新服务；不因语言统一重写已部署服务。 |

桌面端不引入第二套 UI 框架或 Rust UI 渲染体系。如未来更换可视层技术，必须以业务整页为单位，在同一变更内删除被替代的旧 UI；不用产品内双轨作为回退。

## 前端分层

```text
ui/ 唯一可视层
        ↓
feature state / rules / controller
        ↓
tauri-api
        ↓
Rust commands / domain / storage / sync
```

- `contracts/` 是跨端数据和 API 语义的唯一事实来源。
- 复杂流程（同步、导入、账户恢复、阅读器外壳）使用显式状态机或 reducer。
- 业务页不直接散落调用 `window.__TAURI__`；原生能力通过类型化适配边界进入。
- 页面内的空态、加载、错误和取消都由同一可视实现承担。

### 统一叠层规则

- 所有跨页浮层只申明语义角色：默认为 `operation`，信息/说明/详情为 `information`，必须压住业务交互的确认为 `critical`，手势提示、手势轨迹和全局短提示为 `feedback`。
- 固定层级关系是 `feedback > critical > interactive`；`information` 与 `operation` 同属交互层，按实际打开顺序叠放，确保从当前窗口继续打开的新窗口总在上面。
- 跨页浮层必须挂载到当前窗口顶层 `document.body`，声明 `data-overlay-surface` 和 `data-overlay-role`；短暂反馈还要用 `data-overlay-active="true"` 表示正在显示。iframe 内的功能不得在 iframe 内绘制全局提示，应通知所属窗口的顶层反馈层。
- 业务页不按页面 ID 或功能写具体 `z-index`。新浮层只声明语义角色，层级由共享 `overlay-stack` 统一计算。

## 工程门禁

1. TypeScript 源码使用 `strict` 类型检查；
2. 新规则/controller 有单元测试；
3. 涉及 Tauri 交互时增加集成或端到端验收；
4. `ui/tests/governance.test.cjs` 阻止再次引入双 UI；
5. 可见改动后构建完整 macOS 应用，并使用规定脚本覆盖安装。
