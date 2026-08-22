# `@kunpeng/contracts-ts`

这是桌面 TypeScript 代码访问仓库契约的受控入口，不是新的契约来源。

- 机器可读权威定义仍是 `contracts/**/*.schema.json`。
- 示例仍是 `contracts/fixtures/*.json`。
- `syncContractSchemaManifest` 只给出这两个来源的稳定仓库相对路径。
- `parseAppSettingsFixture` 只验证协议 v5 `app_settings_v1` 的必需包络和前端依赖字段；未来未知字段原样保留，但已退役的 `readerJumpBackSizeLevel` 必须拒绝。它**不能**替代服务端或完整 JSON Schema 校验。

在仓库根目录可验证真实 fixture：

```sh
node packages/contracts-ts/test/validate-app-settings-fixture.mjs
```

新增共享语义时必须先遵守 `AGENTS.md`：先更新 ADR、`contracts/` schema 与 fixture，再在此处扩展受控类型入口。
