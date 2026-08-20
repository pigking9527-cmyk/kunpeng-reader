# 原版阅读器严格 TypeScript 迁移：第一批

本目录只包含无视图规则与状态。它不定义 DOM、HTML、CSS、React/TSX、页面入口或第二套 UI；当前唯一用户可达实现仍为 `ui/`。

## 已建立的对应关系

| TypeScript | 现行经典脚本 | 已覆盖边界 |
| --- | --- | --- |
| `shell-state.ts` | `ui/reader-shell-state.js` | overlay、侧栏、沉浸工具栏状态转换，`immersive` 存储值与渲染投影 |
| `startup-guard.ts` | `ui/reader-startup-guard.js` | 启动状态、正文 URL allowlist、诊断压缩、依赖摘要、超时常量 |
| `navigation-rules.ts` | `ui/reader-navigation-rules.js` | 跳转点归一化、去重、有界历史、按页收起返回入口 |
| `jump-back-rules.ts` | `ui/reader-jump-back-rules.js` | 返回图标尺寸、位置、命中区几何 |
| `preferences.ts` | `ui/reader.js`、`ui/reader-page-annotations.js` | 高亮菜单快照解析；词典六项默认关闭、仅显式 true 恢复、开启前按当前词检测可用性 |

## 产物接入要求与旧脚本删除条件

本批没有改构建配置，也没有切换 `ui/reader.html`，因此目前不能删除任何经典脚本。接入必须在后续单独占用 `ui/` 与构建配置后一次完成，并满足：

1. 将本目录编译为经典页面可加载的单一 IIFE 产物，不加入第二个页面或备用 DOM。
2. 产物继续暴露现行全局 API 名称：`ReaderShell`、`ReaderStartupGuard`、`ReaderNavigationRules`、`ReaderJumpBackRules`；不得改变 `immersive`、`readerHighlightMenuPreferencesV1`、`dictEnhancementSettingsV2` 等键。
3. 接线时由现行 `ui/reader-shell-state.js` 等脚本原位替换，而不是让新旧实现同时运行。
4. 对 DOM class、事件名、全局方法、消息 payload、关闭顺序、计时器及异常回退做逐项契约测试，并完成原版视觉截图对比。
5. 运行全部 Legacy UI、strict TypeScript、ESLint、Rust、Release 构建、macOS 安装及实机验收后，才删除对应旧脚本。

## 尚未迁移

- `ui/reader-message.js` 的全部旧 payload 验证与 typed-envelope 兼容路由；现有 `reader-protocol-bridge.ts` 只覆盖 typed envelope。
- `ui/reader.js` 的 DOM 编排、Tauri invoke/event、进度保存、TTS、书籍信息、相关推荐和 iframe 消息分发。
- `ui/reader-settings-ui.js`、`reader-preferences-ui.js`、`reader-click-zones-ui.js`、`reader-gesture.js`。
- 搜索、跨书搜索、批注/笔记、AI 历史与推荐设置的页面控制器。
- EPUB/PDF 命令式引擎、分页、选区、图片、脚注和高频 Canvas/DOM 渲染。

这些剩余项必须继续在同一原版页面内按边界替换；不得新建候选页面、React 树或第二套样式。
