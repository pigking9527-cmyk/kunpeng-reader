# 同步 API 协议 v4（历史，已被 v5 取代）

> 此文件仅保留 v4 的历史记录。当前破坏性开发基线是
> [`api-v5.md`](api-v5.md) 与 ADR-0031；不得将本文件用于 v5 实现、兼容或切流。

HTTP 基址继续使用 `/v1`。所有 `/v1/sync/*` 请求必须声明：

```http
X-Sync-Protocol-Version: 4
```

缺失或不是 `4` 时，在解析实体内容和执行数据库写入前返回：

```json
{
  "error": {
    "code": "SYNC_PROTOCOL_UNSUPPORTED",
    "message": "sync protocol version 4 is required",
    "requestId": "00000000-0000-0000-0000-000000000000"
  }
}
```

## v4 数据边界

- `updated_at` 和非零 `deleted_at` 必须是 Unix epoch 毫秒；不再接受旧秒级时钟。
- `ai_reader_history_v1` 不再是可写实体；仅使用 `ai_reader_history_entry_v2`。
- 客户端必须保留未知 JSON 字段；服务端不会仅因未知字段拒绝实体。
- 墓碑、LWW 比较顺序、`data_generation`、资产和恢复语义继续由现有 sync contracts 与 ADR 定义。

## 统一错误

错误响应使用 `application/json`，最多包含下列字段：

```json
{
  "error": {
    "code": "SERVER_BUSY",
    "message": "server is temporarily busy",
    "requestId": "00000000-0000-0000-0000-000000000000",
    "retryAfterSeconds": 1
  }
}
```

`message` 是面向开发的非敏感说明，客户端行为只能依赖稳定 `code`。

## 最小同步表面

- `POST /v1/sync/push`：请求体含客户端生成的 UUID `mutation_id`、`data_generation`
  和 `entities`。相同账户、相同 `mutation_id`、相同请求内容在七天内返回首次结果；
  相同 `mutation_id` 换内容返回 `IDEMPOTENCY_CONFLICT`。响应使用
  `accepted` 和 `conflicts`；不被 LWW 接受的写入必须返回权威服务端实体。
- `GET /v1/sync/pull?cursor=<n>&limit=<n>`：按只增不减的服务端游标返回实体，
  并返回 `next_cursor`、`has_more` 和 `data_generation`。
- 两个端点都需要 Bearer 会话、已验证邮箱和 `X-Sync-Protocol-Version: 4`。

服务端内部存储结构不是协议；客户端只能依赖本文档、schema 和 fixture。

认证与注册使用 `/v1/auth/*`，注册请求和响应以
[`contracts/auth/registration-v2.md`](../auth/registration-v2.md) 为准；同步协议 v4
不另行定义第二套注册语义。登录、注册确认、`GET /v1/auth/session` 与
`GET /v1/auth/me` 返回同一稳定 `user`、`dataGeneration` 和 `syncEnabled`；只有登录和
注册确认返回明文会话 Token，身份查询不得回显 Token。
