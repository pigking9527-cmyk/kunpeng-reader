# 账号密码找回 v2

所有请求使用 `contracts/sync/api-base-v1.md` 定义的 `/v1` API 基址。只有已经绑定并验证邮箱的账户可使用该流程；请求与响应均不得泄露该账号或邮箱是否存在。

验证码是服务端邮件 outbox 投递的一次性六位数字。服务端只保存其带挑战 ID 的不可逆摘要，15 分钟后失效；密码、验证码、Token、邮箱地址和本机路径不得进入日志、fixture 或仓库记录。

## 请求验证码

`POST /v1/auth/password/reset/request`

```json
{
  "username": "example-user",
  "email": "reader@example.invalid"
}
```

成功返回 `202`：

```json
{ "ok": true, "expiresIn": 900 }
```

请求按 IP 和账户匿名摘要限流；超过限流返回 `429 RATE_LIMITED`。邮件未配置或暂不可投递返回 `503 REGISTRATION_UNAVAILABLE`，不透露账户状态。

## 确认新密码

`POST /v1/auth/password/reset/confirm`

```json
{
  "username": "example-user",
  "code": "000000",
  "newPassword": "replacement-password",
  "installationId": "stable-random-installation-id",
  "deviceName": "macOS"
}
```

`username` 长度为 3–32 个 ASCII 字符，只允许字母、数字、`_` 和 `-`。`newPassword` 长度为 8–32 个 Unicode 字符；`installationId` 为当前安装的稳定随机 ID，长度最多 128；`deviceName` 可选、最多 64 字节，仅用于设备展示。

成功返回 `200`，形状与登录响应一致，并携带**当前安装**的新会话 Token：

```json
{
  "ok": true,
  "token": "new-session-token",
  "user": { "id": "opaque-user-id", "username": "example-user", "syncEnabled": true },
  "dataGeneration": 1,
  "syncEnabled": true,
  "expiresAt": 0
}
```

无效、过期或已消费验证码统一返回 `400 INVALID_OR_EXPIRED_CODE`。服务端必须在同一事务中 CAS 更新密码哈希、消费挑战、撤销该账户全部旧会话并签发当前安装的新会话；后续确认必须失败。确认同样受 IP 和账户匿名摘要限流。
