# 同步 API 协议 v5

这是协议 v5 的破坏性开发基线。HTTP 基址仍为 `/v1`，但桌面端与 Axum 的完整 wire
对齐和受保护 PostgreSQL E2E 完成前，**不得部署或切换流量**。

所有 `/v1/sync/*` 请求必须声明：

```http
X-Sync-Protocol-Version: 5
```

缺失或不是 `5` 时，服务端必须在解析实体内容和执行数据库写入前返回 HTTP 426：

```json
{
  "error": {
    "code": "SYNC_PROTOCOL_UNSUPPORTED",
    "message": "sync protocol version 5 is required"
  }
}
```

## v5 数据边界

- `updated_at` 与非零 `deleted_at` 是 Unix epoch 毫秒。
- `app_settings_v1/default` 必须含 30–160 的整数 `readerJumpBackIconSizePx`，且不得含
  `readerJumpBackSizeLevel`。该退役字段没有读取、换算或镜像兼容。
- 客户端保留未来未知 JSON 字段；该保证不适用于 v5 明确退役的字段。
- 墓碑、LWW、`data_generation`、资产和恢复语义由现有 sync contracts 与 ADR 定义。

## 必须对齐的表面

认证使用 `/v1/auth/*`。同步与账户功能必须覆盖桌面实际使用的 push、pull、inventory、
reconcile、密钥状态/重置、数据重置、资产以及账户安全/用量表面，并以 v5 header、请求
体和响应语义完成端到端验证。单独存在的 push/pull 路由不足以宣布 v5 就绪。

账户安全还包括经过认证的邮箱绑定与换绑；其精确 route、挑战和短时授权码边界见
[`../auth/email-binding-v1.md`](../auth/email-binding-v1.md)。它们位于 `/v1/auth/*`，不是
`/v1/sync/*`，因此不发送同步协议 header。

旧 [`api-v4.md`](api-v4.md) 与 Python 服务均为 pre-v5 历史资料，不能作为 v5 回退或
兼容路径。完整切换与回滚条件见 [ADR-0031](../../docs/adr/0031-sync-protocol-v5-breaking-app-settings.md)。
