# 原版基础脚本 TypeScript 迁移

本目录不定义 DOM、样式、组件树或新页面，只提供与原 classic script 同 basename 的安装器。

| TypeScript installer | replaces | hosts |
| --- | --- | --- |
| `installRecoverySettingsSnapshot` | `ui/recovery-settings-snapshot.js` | `ui/index.html`, `ui/reader.html` |
| `installBrowserNativeGuard` | `ui/browser-native-guard.js` | `ui/index.html`, `ui/reader.html`, `ui/pdfview.html` |

实际接入时只能在原位加载生成的 classic/IIFE 产物，并同时删除对应旧实现；不得新旧双加载。
