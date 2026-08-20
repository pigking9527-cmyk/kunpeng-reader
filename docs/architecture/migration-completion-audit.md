# 桌面 UI 唯一实现审计

> 审计日期：2026-08-13。

## 结论

产品主窗口、阅读窗口、搜索窗口以及设置、账户、统计、资讯和书架页面只由 `ui/` 下的现行实现承载。之前的 React iframe、独立候选页、loader、挂载宿主、生成产物和可视组件已删除。

`apps/desktop-ui/` 保留 TypeScript 的 state、rules、controller 和 port，这些是无视图业务边界，不构成第二套 UI。Vite 仅构建 PDF adapter 和 reader protocol bridge。

## 自动检查

```sh
npm run lint
npm run typecheck
npm run test:typed
npm run test:legacy-ui
npm run desktop-ui:build
```

`ui/tests/governance.test.cjs` 额外检查：产品 HTML 直接加载唯一入口、不存在 React/JSX 页面、双轨脚本和“打开旧版”文案，也不保留 React 运行时依赖。
