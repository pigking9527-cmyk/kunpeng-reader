# 原版主窗口 TypeScript 第一批

本目录只包含无视图实现；不定义 DOM、HTML、CSS、React 组件或第二套 UI。

| TypeScript | 等价旧脚本 | 旧脚本可删除条件 |
| --- | --- | --- |
| `shelf-ui-rules.ts` | `ui/shelf-ui-rules.js` | IIFE 产物在 `shelf-ui.js` 之前加载，且 `window.ReaderShelfRules` 已通过旧 UI 回归。 |
| `animation-settings.ts` | `ui/animation-settings.js` | IIFE 产物在主窗口和阅读窗口的动画调用者之前加载，存储迁移与 `reader-animation-settings-changed` 回归通过。 |
| `semantic-status-cache.ts` | `ui/semantic-status-cache.js` | IIFE 产物在 `app.js` / `library-ai.js` 之前加载，V3 快照、刷新回填和删除索引回归通过。 |
| `overlay-stack.ts` | `ui/overlay-stack.js` | IIFE 产物在所有浮层脚本之前加载，并在主窗口、阅读窗口、搜索窗口和 PDF 窗口验证层级。 |

`runtime-entry.ts` 是兼容入口，安装与旧脚本同名的四个全局 API。接入时应构建为单个 classic/IIFE 脚本并原位替换上述旧脚本；不得同时加载新旧两份运行实现。
