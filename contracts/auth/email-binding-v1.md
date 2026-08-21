# 账户邮箱绑定与换绑 v1

所有端点使用 [`../sync/api-base-v1.md`](../sync/api-base-v1.md) 的 `/v1` 基址，并要求
`Authorization: Bearer <token>`、`Cache-Control: no-store`。这些是认证端点，不要求也不接受
`X-Sync-Protocol-Version`；该请求头只适用于 `/v1/sync/*`。

邮箱在服务端按去除首尾空白后的 ASCII 小写值比较，必须是有效地址且不超过 254 字节。服务端
不会把邮箱、验证码或换绑授权码写入响应日志；客户端同样不得持久化未完成流程的验证码或授权码。

## 绑定第一个邮箱

### 发送验证码

`POST /v1/auth/email/start`

请求体字段：`email`（待绑定邮箱）。账户尚未绑定邮箱，且该邮箱未被任何账户绑定时，服务端投递
一次性验证码并返回 `202`：

```json
{ "ok": true, "expiresIn": 900, "requestId": "uuid" }
```

### 确认验证码

`POST /v1/auth/email/confirm`

请求体字段：`email`、`code`。`code` 是本次邮件投递的 6 位数字，15 分钟后失效，最多允许 5 次
验证尝试。成功返回 `200` 和同形状的 `{ "ok": true, "expiresIn": 900, "requestId": "uuid" }`。
确认在同一事务中消费挑战、绑定邮箱并设置账户的同步邮箱验证状态；之后该账户可以调用
`/v1/sync/*`。

## 换绑邮箱

换绑必须先证明控制旧邮箱，再向新邮箱发送验证码。它不更改同步实体、`dataGeneration` 或现有会话。

1. `POST /v1/auth/email/rebind/old/start`，请求体为空对象。已绑定旧邮箱时返回 `202` 和挑战响应。
2. `POST /v1/auth/email/rebind/old/confirm`，请求体字段：`code`。成功返回 `200`：

   ```json
   { "ok": true, "rebindGrant": "opaque transient secret", "requestId": "uuid" }
   ```

   `rebindGrant` 是只可使用一次的 15 分钟不透明授权码。客户端仅可将它保留在正在进行的换绑操作
   内存中，绝不能写入磁盘、设置、同步实体、fixture 或日志。
3. `POST /v1/auth/email/rebind/new/start`，请求体字段：`email`、`rebindGrant`。新邮箱必须与旧邮箱
   不同且未被绑定。成功返回 `202` 和挑战响应；服务端在受理时消费授权码，因此失败、过期或中断后
   不得重用它，客户端应从旧邮箱验证步骤重新开始。
4. `POST /v1/auth/email/rebind/new/confirm`，请求体字段：`email`、`code`。成功返回 `200` 和挑战响应，
   并在同一事务中消费新邮箱挑战、替换绑定邮箱及更新时间。账户仍保持已验证同步资格。

## 错误与重试

所有路由都要求有效会话；无效会话返回 `401 UNAUTHORIZED`。请求体缺字段、未知字段、无效邮箱或
非六位数字验证码返回 `400 INVALID_REQUEST`。挑战不存在、已消费、过期、尝试次数耗尽或验证码不对
统一返回 `400 INVALID_OR_EXPIRED_CODE`；换绑授权码无效、已消费或过期返回
`400 INVALID_OR_EXPIRED_REBIND_GRANT`。

重复绑定、目标邮箱已归属其他账户，或确认阶段发现邮箱已被占用时返回
`409 EMAIL_ALREADY_BOUND`。开始旧邮箱换绑但账户未绑定邮箱时返回 `400 EMAIL_NOT_BOUND`；新旧邮箱
相同返回 `400 EMAIL_UNCHANGED`。三个“发送验证码”端点按账户限流，超限返回 `429 RATE_LIMITED`；
邮件服务未配置或不可用时返回 `503 REGISTRATION_UNAVAILABLE`。客户端仅在收到成功响应后推进下一步，
对 `429` 按 `Retry-After` 退避，且不得猜测挑战是否已发送。

## 账户安全状态

操作完成后，桌面客户端通过 `GET /v1/auth/security` 刷新显示。响应中的 `emailBound` 是是否已绑定的
布尔值，`email` 是可展示的脱敏地址；它不是用于再次提交、比较或恢复邮件的原始邮箱。
