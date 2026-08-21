# 原版窗口运行时 TypeScript 迁移

本目录只替换原有 classic script 的实现，不定义页面、样式、组件树或新入口。

| TypeScript installer | 等价旧脚本 | 经审核的运行时依赖 |
| --- | --- | --- |
| `installTitlebar` | `ui/titlebar.js` | `WindowControls` 的最小化、最大化切换、关闭 |
| `installWindowResize` | `ui/window-resize.js` | Linux 下 `WindowControls.startResizeDragging` 的 8 个 Rust 方向 |
| `installStartupPerf` | `ui/startup-perf.js` | `WindowControls.elapsedSinceProcessStartMs` |
| `installStartupEnhancementUi` | `ui/startup-enhancement-ui.js` | typed `startup_enhancement_config`, `set_startup_enhancement_config` and `startup-enhancement-state` |

三个安装器的文件名与待替换脚本同 basename，可由单一 UI 的 classic/IIFE 生成链按原顺序就地接入。接入时不得同时加载新旧实现。
