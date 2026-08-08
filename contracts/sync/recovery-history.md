# 云端同步恢复历史 API

本契约由 ADR-0017 定义，是同步 API v2 的可选恢复扩展，不改变 `syncProtocolVersion`。 请求与响应的机器可读结构见 [`recovery.schema.json`](recovery.schema.json)。

## `GET /sync/recovery/status`

需要 Bearer Token。响应只包含元数据，不返回历史 payload：

```json
{
  "ok": true,
  "schema_version": 1,
  "server_time": 1786160000000,
  "data_generation": 1,
  "retention_days": 90,
  "available": true,
  "enabled_at": 1786150000000,
  "restorable_from": 1786150000000,
  "latest_version_at": 1786159000000,
  "version_count": 42,
  "compressed_bytes": 16384,
  "uncompressed_bytes": 65536,
  "last_pruned_at": 1786159500000
}
```

`restorable_from` 之前的目标必须拒绝。首次部署以前没有历史，不得推断可恢复。

## `POST /sync/recovery/restore`

需要 Bearer Token 和登录密码：

```json
{
  "password": "用户现场输入，不得记录",
  "confirm": true,
  "target_at": 1786155000000,
  "data_generation": 1
}
```

成功响应：

```json
{
  "ok": true,
  "target_at": 1786155000000,
  "restored_at": 1786160000000,
  "restored_entities": 120,
  "tombstoned_entities": 3,
  "data_generation": 2,
  "tokens_revoked": true
}
```

恢复是账户级破坏性操作：成功后客户端必须清除旧认证状态、重新登录，并先完成 pull 再允许 push。目标时间之后才创建的实体必须产生新墓碑，不能仅从服务端删除。`secret_bundle_v1` 不参与时间恢复。

错误至少包含：`RECOVERY_CONFIRMATION_REQUIRED`、`INVALID_CREDENTIALS`、`DATA_GENERATION_MISMATCH`、`RECOVERY_UNAVAILABLE`、`RECOVERY_TARGET_OUT_OF_RANGE`、`RECOVERY_HISTORY_CORRUPT` 和 `RECOVERY_ENTITY_LIMIT`。

## 保留和删除

服务端保留最近 90 天全部已接受变更，并为每个实体保留一条窗口前锚点。用户主动清除云端同步数据或永久删除账号时，历史同时物理删除；对象存储整库快照必须执行相同的数据生命周期和访问控制。