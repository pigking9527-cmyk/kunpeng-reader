# 原版主窗口 TypeScript 业务规则第二批

本目录只迁移现行原版页面已经使用的无视图规则，不包含 DOM、HTML、CSS、React/TSX、组件树或第二套 UI。

| TypeScript 唯一源码 | 等价 classic 脚本 | 原位替换门槛 |
| --- | --- | --- |
| `search-result-rules.ts` | `ui/search-result-rules.js` | classic/IIFE 产物仍注册 `window.ReaderSearchResultRules`，搜索高亮、HTML 转义和排序的 VM 等价测试通过。 |
| `search-history-rules.ts` | `ui/search-history-rules.js` | 产物在 `search.js` 之前加载，历史去重、次数/时间排序和损坏输入回归通过。 |
| `stats-rules.ts` | `ui/stats-rules.js` | 产物在 `stats-ui.js` 之前加载，日/月/年/累计范围和首末日期导航等价。 |
| `news-layout-rules.ts` | `ui/news-layout-rules.js` | 产物在 `news-ui.js` 之前加载，列数、卡片估高和稳定最短列分配等价。 |
| `gesture-hint-rules.ts` | `ui/gesture-hint-rules.js` | 产物在 `gesture-ui.js` 之前加载，提示设置、快捷颜色、自由路径和 clip-path 等价。 |

接入构建时，每个 TypeScript 文件只能生成并原位替换对应的一个 classic 脚本；不得同时装载旧实现与新实现，也不得增加候选入口或回退开关。当前目录不直接修改 `ui/`，由统一构建/切换会话在全量旧 UI 回归通过后完成单次替换。
