# 账户数据生命周期 API

所有端点仅允许 HTTPS（localhost 调试除外），使用 `Authorization: Bearer <token>`，并返回 `Cache-Control: no-store`。密码、Token 和本机路径不得写入日志。

## 数据世代

- 每个账户拥有整数 `data_generation`，初始值为 `1`，只增不减。
- `/v1/auth/register`、`/v1/auth/login`、`/v1/auth/me`、`/v1/sync/pull`、`/v1/sync/inventory`、`/v1/sync/push` 和 `/v1/sync/reconcile` 返回 `data_generation`。
- 新版客户端在 `/v1/sync/push` 与 `/v1/sync/reconcile` JSON 中发送 `data_generation`。
- 当前世代大于 1 时，缺失或不相等的写请求返回 HTTP 409、`DATA_GENERATION_MISMATCH`，不得接收任何实体。

## 清空云端同步数据

`POST /v1/sync/data/reset`

请求：

```json
{ "password": "用户当前登录密码" }
```

成功响应：

```json
{ "ok": true, "data_generation": 2, "tokens_revoked": true }
```

服务端必须在同一事务中删除该账户全部同步实体、递增数据世代并撤销该账户全部令牌。密码错误返回 401 `INVALID_CREDENTIALS`。

## 永久删除账户

`POST /v1/auth/account/delete`

请求：

```json
{ "password": "用户当前登录密码", "username": "完整账号名" }
```

成功响应：

```json
{ "ok": true, "account_deleted": true }
```

服务端必须校验密码和完整账号名，并在同一事务中删除该账户所有从属记录及账户本身。账号名不匹配返回 400 `ACCOUNT_CONFIRMATION_MISMATCH`；密码错误返回 401 `INVALID_CREDENTIALS`。
