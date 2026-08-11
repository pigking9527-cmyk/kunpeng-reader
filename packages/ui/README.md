# `@kunpeng/ui`

这是桌面业务 UI 的最小视觉基础包。它不会导入、覆盖或迁移遗留 `ui/` 的样式。

## 使用方式

在新应用的入口一次性导入 `src/tokens.css`，并把 `kp-ui` 放在新应用自己的根节点上：

```tsx
import "@kunpeng/ui/src/tokens.css";
import { interactiveAttributes, uiRootAttributes } from "@kunpeng/ui";

export function App() {
  return (
    <main {...uiRootAttributes("light")}>
      <button {...interactiveAttributes()}>同步</button>
    </main>
  );
}
```

通过根节点的 `data-kp-theme="dark"` 切换深色主题。不要把这个属性放到遗留窗口的 `body` 上；新入口必须有自己的 `.kp-ui` 根节点。

## 令牌规则

- 颜色使用语义变量（如 `--kp-color-accent`），不在业务 CSS 中散落色值。业务含义相同的状态复用同一语义 token。
- 间距使用 `--kp-space-*`；基础步长为 4 px。组件内部优先 2/3/4，区块之间优先 6/8/10。
- 字体使用 `--kp-font-sans` 和 `--kp-font-size-*`。书籍正文排版是阅读引擎的职责，不使用本包 token 改写。
- 圆角、阴影、时长和缓动只使用对应 `--kp-*` token。动效必须自动遵从 `prefers-reduced-motion`。

## 基础组件约定

未来组件应在各功能包内开发，成熟后再进入本包；当前不预设具体组件实现以避免过早锁定 API。

| 组件 | 最小约定 |
| --- | --- |
| Button / IconButton | 使用原生 `<button>`；图标按钮必须有可访问名称；交互元素加 `data-kp-interactive="true"`。 |
| TextField / Select | 使用原生表单语义，并以 `<label>` 或 `aria-label` 命名；错误文本通过 `aria-describedby` 关联。 |
| Dialog | 使用可聚焦的模态语义，打开后移动焦点，关闭后还原触发元素焦点；Esc 和关闭按钮一致生效。 |
| Menu / Listbox | 使用原生控件优先；自定义键盘行为时必须实现方向键、Enter、Esc 和可见焦点。 |
| Status / Toast | 不只依赖颜色表达状态；状态图标或文字必须可读，动态提示按严重程度选择合适的 live region。 |

所有可点击控件的视觉高度至少使用 `--kp-control-height`（40 px）。原生禁用控件使用 `disabled`，自定义控件使用 `aria-disabled="true"` 且不得执行操作；不要仅靠降低透明度表达不可用。

## 边界

- 此包不持有业务状态、不调用 Tauri、不定义同步实体，也不修改 `contracts/`。
- 新业务功能通过自己的 CSS Modules（或等价局部样式）组合 token；不要向这里添加全局选择器。
- 令牌变更应保持浅色/深色对称，并检查文本、焦点环和状态色的可辨识性。

## 验证

根目录运行 `npm run typecheck`。`test/type-contracts.ts` 由严格 TypeScript 编译器覆盖，用于防止导出类型和辅助函数的契约漂移。
