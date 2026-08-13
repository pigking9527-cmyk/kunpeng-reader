# 云端同步恢复历史 API

本契约由 ADR-0017 定义，是同步 API 的可选恢复扩展。协议 v5 使用同一恢复语义，
但每个 `/v1/sync/*` 请求仍须遵守 v5 请求头。请求与响应的机器可读结构见
[`recovery.schema.json`](recovery.schema.json)。

## `GET /v1/sync/recovery/status`

需要 Bearer Token。响应只包含元数据，不返回历史 payload：

```json
{
  "ok": true,
  "schemaVersion": 1,
  "serverTime": 1786160000000,
  "dataGeneration": 1,
  "retentionDays": 90,
  "available": true,
  "enabledAt": 1786150000000,
  "restorableFrom": 1786150000000,
  "latestVersionAt": 1786159000000,
  "versionCount": 42,
  "compressedBytes": 16384,
  "uncompressedBytes": 65536,
  "lastPrunedAt": 1786159500000
}
```

`restorableFrom` 之前的目标必须拒绝。首次部署以前没有历史，不得推断可恢复。

## `POST /v1/sync/recovery/restore`

需要 Bearer Token 和登录密码：

```json
{
  "password": "用户现场输入，不得记录",
  "confirm": true,
  "targetAt": 1786155000000,
  "dataGeneration": 1
}
```

成功响应：

```json
{
  "ok": true,
  "targetAt": 1786155000000,
  "restoredAt": 1786160000000,
  "restoredEntities": 120,
  "tombstonedEntities": 3,
  "dataGeneration": 2,
  "tokensRevoked": true
}
```

恢复是账户级破坏性操作：成功后客户端必须清除旧认证状态、重新登录，并先完成 pull 再允许 push。目标时间之后才创建的实体必须产生新墓碑，不能仅从服务端删除。`secret_bundle_v1` 不参与时间恢复。

错误至少包含：`RECOVERY_CONFIRMATION_REQUIRED`、`INVALID_CREDENTIALS`、`DATA_GENERATION_MISMATCH`、`RECOVERY_UNAVAILABLE`、`RECOVERY_TARGET_OUT_OF_RANGE`、`RECOVERY_HISTORY_CORRUPT` 和 `RECOVERY_ENTITY_LIMIT`。

## 保留和删除

服务端保留最近 90 天全部已接受变更，并为每个实体保留一条窗口前锚点。用户主动清除云端同步数据或永久删除账号时，历史同时物理删除；对象存储整库快照必须执行相同的数据生命周期和访问控制。
