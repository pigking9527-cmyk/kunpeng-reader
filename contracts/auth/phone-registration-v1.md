# 手机验证码注册 v1

手机注册是邮箱注册之外的可选两阶段认证入口，不修改同步协议版本。所有响应使用
`Cache-Control: no-store`，服务端不得在日志或错误响应中返回手机号、验证码或短信供应商信息。

## 发送验证码

`POST /v1/auth/register/phone/start`

```json
{
  "username": "reader_01",
  "phone": "+8613711112222",
  "installationId": "stable-installation-id"
}
```

- `phone` 必须是规范 E.164：一个 `+` 后接 8–15 位数字，国家码后第一位不能为 `0`。
- `installationId` 是本机稳定、非硬件指纹的安装标识，最多 128 字节。
- 成功返回 HTTP 202：`{"ok":true,"expiresIn":300,"requestId":"..."}`。
- 账号或号码已占用、60 秒内重复发送时仍返回同形状 202，避免枚举。
- 短信未配置返回 503 `PHONE_REGISTRATION_UNAVAILABLE`；每日安全额度耗尽返回
  503 `SMS_BUDGET_EXCEEDED`；多维限制触发返回 429 `RATE_LIMITED`。

短信模板有两个变量，顺序固定为验证码和有效分钟数。只有短信供应商确认接受投递后，挑战
才能进入确认阶段。

## 确认并创建账号

`POST /v1/auth/register/phone/confirm`

```json
{
  "username": "reader_01",
  "phone": "+8613711112222",
  "code": "123456",
  "password": "user-chosen-password",
  "installationId": "stable-installation-id",
  "deviceName": "macOS"
}
```

验证码是 6 位数字、5 分钟有效、最多尝试 5 次且只能成功消费一次。成功返回 HTTP 201 和既有
`SessionResponse`，同时创建已启用同步的账号及首个设备会话。错误验证码、过期、未投递或已
消费统一返回 400 `INVALID_OR_EXPIRED_CODE`；账号或手机号竞态冲突返回 409
`REGISTRATION_CONFLICT`。

`username` 长度为 3–32 个 ASCII 字符，只允许字母、数字、`_` 和 `-`。`password` 长度为
8–32 个 Unicode 字符。

客户端不得持久化未完成注册的密码或验证码。短信 SecretId/SecretKey、应用 ID、签名和模板
ID 只属于服务端配置。

## 数据最小化

账号长期数据只允许保存：域分离 keyed HMAC 手机摘要、末四位和验证时间。完整号码与验证码
只允许存在于短时挑战及 outbox；投递成功、最终失败或注册成功后清空，过期记录 24 小时内
删除。手机号注册本身不提供密码找回；用户仍需绑定已验证邮箱使用现有找回流程。
