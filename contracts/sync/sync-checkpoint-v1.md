# 同步 checkpoint v1

`GET /v1/sync/checkpoint` 是协议 v5 的**可选**只读会话捷径。它不替代
`pull`、`inventory` 或 `reconcile`，也不改变任何既有端点。

请求必须携带 `Authorization: Bearer …` 与
`X-Sync-Protocol-Version: 5`，并包含以下 query 参数：

```text
dataGeneration=<客户端当前数据世代>&cursor=<客户端最后完整应用的服务端游标>
```

- `dataGeneration` 必须为正整数；与当前账户世代不一致时返回 `409
  DATA_GENERATION_MISMATCH`。
- `cursor` 必须为非负整数。它只能是客户端在一个完整、`hasMore: false` 的 pull
  结果后持久化的 `nextCursor`；不得拿未完成页面、局部 kind 或本地合成值调用。
- 成功响应的 `serverCursor` 是该账户当前实体流的最高服务端游标；没有实体时为 `0`。
- `caughtUp` 只在请求 `cursor` **严格等于** `serverCursor` 时为 `true`。大于服务端
  高水位的损坏游标也必须为 `false`。

```json
{
  "ok": true,
  "dataGeneration": 1,
  "cursor": 42,
  "serverCursor": 42,
  "caughtUp": true,
  "requestId": "00000000-0000-4000-8000-000000000001"
}
```

客户端仅可在没有待上传变更、上次 pull 已完成且仍处于同一 `dataGeneration` 时使用
它。`caughtUp: true` 可以跳过本轮 pull、inventory/reconcile；客户端仍必须至少每小时
执行一次完整清单修复。`false`、409、网络失败，以及客户端自己的周期性自愈检查都必须
继续使用现有 pull/inventory/reconcile 流程。这样 checkpoint 不会成为遗漏墓碑、未知字段或
本地清单差异的唯一权威来源。
