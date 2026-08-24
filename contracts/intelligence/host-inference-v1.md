# 情报主机端到端加密推理中继 V1

本契约允许已登录客户端把**私有的理解任务**中继给用户自己的情报主机。它与
`PublicationBundleV1` 的公开资讯分发是两套协议：前者传递不透明密文，后者传递可验证的
公开内容包。两者都不属于 `/v1/sync/*` 实体。

## 安全与数据边界

- 任务正文、书籍/新闻原文、RAG 片段、提示词、模型回答、引用、模型名称、向量、索引、
  本机路径和任何私钥只能存在于客户端或主机的解密端。服务端只保存路由所必需的账号 ID、
  配对 ID、操作枚举、密文、密文摘要、状态和到期时间。
- 请求和结果均使用 `HPKE-v1-X25519-HKDF-SHA256-CHACHA20POLY1305`。加密 AAD 必须是
  `"kunpeng-intelligence-host-inference-v1"` 加上 canonical JSON
  `{taskId,pairId,operation,capabilityRevision,direction}`；`direction` 为 `request` 或
  `result`。这把密文绑定到准确的主机、能力版本和方向，不能跨任务或跨账号重放。
- 服务端只存密文，不持有解密私钥；`ciphertextSha256` 覆盖密文的原始字节，用于传输完整性，
  不是明文内容摘要。客户端和主机在解密后还必须校验私有明文中的任务 ID、方向和 nonce。
- 一切端点为 HTTPS；Bearer token、能力 credential、配对口令和私钥均不可出现在 URL、日志、
  fixture、同步实体或错误消息中。错误码只能包含稳定枚举与请求 ID，不能回显密文或任务内容。

## 账号配对与能力

1. 已登录客户端创建短时配对邀请。服务端只保留随机邀请口令的哈希，默认 **10 分钟**到期，
   使用一次后立即销毁；扫码/本地传递的原始口令只显示给发起端和主机。
2. 主机使用同一账号登录并领取邀请，同时提交 X25519 公钥、稳定 `hostInstallationId` 与可处理的
   `capabilities`。服务端返回一次性的、安装绑定的 host capability credential；仅保存其哈希，
   可撤销且不能作为普通用户 token 使用。
3. 客户端在确认主机公钥指纹后提交自己的公钥，生成 `HostPairingV1`。后续能力变更提升
   `capabilityRevision`；任务携带该版本，版本不一致则不得领取或提交结果。
4. 用户可随时撤销配对；撤销立即阻止新任务、清除未领取请求和未下载结果，并通知已领取主机
   停止工作与销毁内存中的明文。已解密的主机无法被网络强制擦除，因此主机必须在收到撤销或
   取消状态后不再保存/上传结果。

`operation` 是固定枚举，而不是用户提示词：`library_answer`、`library_compare`、
`reading_deep_analysis`、`reading_memory`、`news_preference`、`news_evidence_review`、
`companion_prompt`。服务端只利用它做能力授权、队列调度和限额，绝不据此生成或读取内容。

## API 形状与状态机

以下为实现端点，具体请求/响应对象见 `host-inference-v1.schema.json`：

| 调用者 | 方法与路径 | 语义 |
| --- | --- | --- |
| 客户端 | `POST /v1/intelligence/host-pairings/offers` | 创建十分钟一次性配对邀请 |
| 主机 | `POST /v1/intelligence/host-pairings/offers/{id}/claim` | 同账号领取邀请并交换公钥/安装能力 |
| 客户端 | `GET /v1/intelligence/host-pairings` | 读取本账号已配对主机的公开能力与指纹 |
| 客户端 | `DELETE /v1/intelligence/host-pairings/{pairId}` | 撤销主机配对和未完成任务 |
| 客户端 | `POST /v1/intelligence/host-tasks` | 提交 `TaskRequestV1` 密文请求 |
| 主机 | `GET /v1/intelligence/host-tasks?wait=25` | 仅用 capability credential 长轮询领取本主机任务 |
| 主机 | `POST /v1/intelligence/host-tasks/{taskId}/claim` | 原子领取；第二次使用新的幂等键确认已开始运行；收到 `CANCEL_REQUESTED` 时确认取消并物理清除请求密文 |
| 主机 | `POST /v1/intelligence/host-tasks/{taskId}/result` | 上传 `EncryptedResultV1`，或提交固定 `failureCode`；两者互斥，均不得含任何明文字段 |
| 客户端 | `GET /v1/intelligence/host-tasks/{taskId}` | 读取状态或端到端密封的结果 |
| 客户端 | `POST /v1/intelligence/host-tasks/{taskId}/cancel` | 请求取消；服务端立即停止结果接受与后续投递 |
| 客户端 | `POST /v1/intelligence/host-tasks/{taskId}/ack` | 解密、验证、持久化本地结果后确认；服务端立即清除结果密文 |

状态为 `QUEUED → CLAIMED → RUNNING → RESULT_READY → PURGED`。主机以独立的幂等
`claim` 确认 `CLAIMED → RUNNING`；这样断线重试不会伪造运行状态。取消走
`QUEUED/CLAIMED/RUNNING → CANCEL_REQUESTED → CANCELLED → PURGED`：客户端首先只请求取消，
主机通过下一次队列轮询获知取消，再调用 `claim` 或携带 `failureCode: "cancelled"` 的
`result` 确认，服务端才删除请求密文。已经 `RESULT_READY` 的任务不再有执行中的主机，取消会
直接删除结果并进入 `CANCELLED`。没有结果的主机可写 `FAILED`，但失败对象只能是
`host_unavailable`、`model_failed`、`input_unsupported` 或 `policy_refused` 等固定枚举，绝不含
模型错误原文。所有写端点要求 `Idempotency-Key`，同 key 不同请求摘要必须返回
`409 IDEMPOTENCY_KEY_REUSED`；回执只保存状态和固定协议元数据，绝不保存密文。

## TTL、取消与销毁

- 服务端在接收任务时用自己的时钟检查 `expiresAt`：必须晚于当前时间、默认 15 分钟、最长
  60 分钟。到点自动进入 `EXPIRED`，立即删除请求密文；主机不得领取或上传结果。
- 结果密文最多保留 24 小时，客户端 ACK 后立即删除。未 ACK 的结果到期直接 `PURGED`；
  服务端不保留备份、恢复历史或标题等派生元数据。
- 取消/撤销与过期优先于结果上传：即使主机在计算，服务端也必须拒绝结果并删除已存在的密文。
  主机在领取前、解密前、模型调用前和上传前均要重新读取状态，收到取消时停止推理并擦除暂存。

## 私有明文规范（不上传）

请求明文和结果明文各自为 versioned JSON/CBOR，但只在端点解密后使用。它们至少具有
`taskId`、`pairId`、`direction`、随机 `nonce` 和 `payload`。`payload` 可以包含正文片段、
证据、回答或引用；它不得被投影到服务端 DTO、审计、同步实体、标题、错误信息或指标。
客户端必须将验证后的结果落入本机缓存/历史，不能把它自动放入公共资讯包。

## 兼容、迁移与回滚

- V1 是新的独立、可选能力，不提升 `syncProtocolVersion`，未实现端必须忽略它；本地理解、
  云端和关闭路由继续可用。
- 首次上线使用 feature gate，默认关闭；仅在配对成功、主机 capability 有效且双方 key
  fingerprint 已确认时允许选择“我的情报主机”。
- 回滚时关闭 feature gate、撤销所有 host credential，并按上述终态清除中继密文；不会影响
  同步实体、本机书库、公开资讯分发或本地模型。

## 验证门槛

实现前必须通过 fixture 校验，并完成互操作测试：错误账号/配对/能力版本拒绝、密文篡改拒绝、
AAD 交叉任务重放拒绝、取消竞态拒绝结果、TTL 物理清除、撤销后主机无法轮询，以及日志/数据库
检查确认不存在正文、提示词、结果、私钥或 pairing secret。
