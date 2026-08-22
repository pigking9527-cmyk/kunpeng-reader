# 原版主窗口纯规则 TypeScript 迁移

这里只提供原 classic script 的严格类型等价实现，不定义页面、DOM 结构、样式或第二套 UI。

| id | source / installExport | replaces | hosts |
| --- | --- | --- | --- |
| `shelf-cover-loading-rules` | `main-rules/shelf-cover-loading-rules.ts` / `installShelfCoverLoadingRules` | `ui/shelf-cover-loading-rules.js` | `ui/index.html` |
| `news-gesture` | `main-rules/news-gesture.ts` / `installNewsGesture` | `ui/news-gesture.js` | `ui/index.html`, `ui/reader.html` |
| `news-rules` | `main-rules/news-rules.ts` / `installNewsRules` | inlined into the original `news-ui` classic bundle | `ui/index.html` |

删除门槛：生成的同 basename classic/IIFE 脚本已在每个 host 中原位替换；manifest 确保 host 仅加载一份实现；VM 等价、strict typecheck、lint、旧 UI 回归与完整桌面构建均通过。`news-rules` 是例外：它作为无视图模块被 `news-ui` 在构建时内联，不能再给原页面增加第二个脚本标签。满足前不得删除旧脚本或双加载。
