# 账号注册 v2

所有请求使用 `contracts/sync/api-base-v1.md` 定义的 `/v1` API 基址。

## 开始注册

`POST /v1/auth/register/start`

```json
{
  "username": "example-user",
  "email": "reader@example.invalid"
}
```

成功响应只表示验证码投递已受理：

```json
{
  "ok": true,
  "expiresIn": 900
}
```

服务端不得在响应中泄露账号名或邮箱是否已存在。触发限流返回 `429 RATE_LIMITED`；注册关闭或邮件不可用返回 `503 REGISTRATION_UNAVAILABLE`。

## 确认并创建

`POST /v1/auth/register/confirm`

```json
{
  "username": "example-user",
  "email": "reader@example.invalid",
  "code": "000000",
  "password": "transient-password",
  "installationId": "stable-random-installation-id",
  "deviceName": "macOS"
}
```

验证码、密码仅用于本次请求。成功响应与登录响应一致，且 `sync_enabled` 为 `true`。错误验证码统一返回 `INVALID_OR_EXPIRED_CODE`；账号或邮箱在确认前已被占用时返回 `REGISTRATION_CONFLICT`。

`username` 长度为 3–32 个 ASCII 字符，只允许字母、数字、`_` 和 `-`。
`password` 长度为 8–32 个 Unicode 字符；可使用密码管理器生成的随机密码。该限制仅约束新注册或新设置的密码，已有账户仍可用原密码登录后再更新。

`installationId` 是安装级会话标识，不是同步实体的 `device_id`，最长 128 个 UTF-8 字符。`deviceName` 是可选、非权威展示名，最长 64 个字符。

## 密码找回

已验证邮箱的账号可按 [`password-reset-v2.md`](password-reset-v2.md) 请求验证码并重置登录密码。客户端不得在本地保存未完成找回流程的密码或验证码。

## 旧入口

`POST /v1/auth/register` 不再创建账号，返回 `409 REGISTRATION_EMAIL_REQUIRED`。客户端不得在本地保存未完成注册的密码或验证码。
