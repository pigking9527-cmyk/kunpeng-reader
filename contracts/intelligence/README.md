# 情报分发 V1 契约

本目录定义独立的 `/v1/intelligence/*` 内容分发协议。它不属于同步实体协议，也不
携带书籍正文、本机档案、模型、向量索引、模型日志或发布主机的私密凭据。

## 内容与时间边界

- `PublicationBundleV1` 是不可变的正式内容包；`bundleSha256` 覆盖**移除
  `bundleSha256` 字段后** canonical JSON 的 UTF-8 字节，canonical JSON 使用递归键
  排序、无额外空白、字符串不做 Unicode 归一化。二进制图片按 `sha256` 单独校验。
- 每个正文 `segment` 都是一个可核验事实单元：它必须至少列出一个属于**同一
  event revision** 的 `noteId`。每个 `note` 必须给出稳定 `sourceId`、该来源已归档
  版本的 `sourceSha256`，以及至少一个 `{paragraphId, sha256}` 段落证据。接收端必须
  拒绝未知/重复 `noteId`、无法解析的 `noteId`、未知/重复 `mediaId`、没有段落证据或
  证据摘要不合格式的包；不可仅检查字段是否非空。
- 模型输入/输出使用 `modelSynthesis` 闭集：只允许稳定 ID、标题和带 `noteId` 的结构化
  文本块，**没有 URL 字段**。模型生成的 `title` 或 `segment.text` 若含 URL 必须拒绝。
  `originalUrl`、视频 URL、来源名称和来源标题只可由发布主机从已验证永久档案投影，
  不能接受模型回传值；`videoUrl` 必须为 HTTPS。
- 发布注册表是 append-only：同一 `publicationId` 的同一 SHA-256 是幂等重放；同一
  ID 的不同 SHA-256 必须拒绝。修订以新的不可变 `publicationId` 发布，不得更新或
  覆盖已发布包。服务端与客户端都必须在落库/展示前执行字段校验、上述引用校验与
  canonical SHA-256 校验。
- 服务端只可读取 `status=published` 且 `expiresAt` 晚于服务端当前时间的包。到期后
  不得通过 feed、publication、asset、检索或错误消息泄漏标题、URL、正文或图片。
- `publishedAt`、`expiresAt`、`issuedAt` 使用 RFC 3339 UTC；事件发生时间使用
  `occurredAt`，允许为未知。`expiresAt` 必须等于 `publishedAt + 30 天`。
- 视频只作为正文块中的已验证 HTTPS `videoUrl`，不上传视频二进制。

## 账户与发布主机

- 除 publisher job 领取外，所有端点都需要 Bearer 身份；未登录 `401`，已登录但
  `intelligence_feed_enabled=false` 为 `403 INTELLIGENCE_ACCESS_DENIED`。
- 公共正文全局一份；`preferences`、delivery、read/favorite/hide 和 archive request
  必须按账号隔离。
- 发布端只接受安装绑定、可撤销的 capability credential。普通用户 token 即使有
  资讯阅读权限，也必须得到 `403 INTELLIGENCE_PUBLISHER_REQUIRED`。
- 每个写操作携带 `Idempotency-Key`。同 key 与同请求哈希返回原收据；同 key 不同
  内容为 `409 IDEMPOTENCY_KEY_REUSED`。

## 客户端端点

| 方法 | 路径 | 结果 |
| --- | --- | --- |
| GET | `/v1/intelligence/capabilities` | 当前账号资讯能力与可用历史范围 |
| GET | `/v1/intelligence/feed?cursor=&limit=` | 已发布且未过期的增量摘要 |
| GET | `/v1/intelligence/publications/{id}` | 校验后的完整 `PublicationBundleV1` |
| GET | `/v1/intelligence/assets/{sha256}` | 已授权的正式图片，支持 Range |
| GET/PUT | `/v1/intelligence/preferences` | 账号隔离的分类与重要性偏好 |
| GET | `/v1/intelligence/stream?cursor=&deviceId=` | SSE 唤醒；`deviceId` 为已注册设备时，服务端持久化该设备的游标 |
| POST | `/v1/intelligence/deliveries/{id}/ack` | 客户端完整保存后确认投递；可选 `X-Intelligence-Device-Id` 将确认同步写入该已注册设备 |
| GET | `/v1/intelligence/archive/calendar` | 仅日期与数量，不含过期内容元数据 |
| POST/GET | `/v1/intelligence/archive-requests[/{id}]` | 创建或查询历史请求 |
| GET/POST | `/v1/intelligence/archive-requests/{id}/content[/ack]` | 下载/确认临时包 |

## 发布主机端点

`heartbeat`、`jobs`、`claim`、`uploads/init`、`uploads/{id}`、`complete`、`not-found`
和 `failed` 分别使用附件方案列出的路径。`jobs?wait=25` 仅使用发布主机 capability
credential，服务端不得把它放入普通 read lane。

## 历史请求状态

`REQUESTED → QUEUED → CLAIMED → UPLOADING → READY → DOWNLOADED → ACKED → PURGED`。
异常状态为 `HOST_OFFLINE`、`NOT_FOUND`、`FAILED`、`REQUEST_EXPIRED`。同一账号的同一
归一化请求可幂等合并；不同账号的状态与下载回执严格隔离。

完整 schema 见 `intelligence-v1.schema.json`；fixture 只使用虚构来源和正文片段。

私有的“我的情报主机”推理中继不属于公开分发包；它使用
[`host-inference-v1.md`](host-inference-v1.md) 与
`host-inference-v1.schema.json`。该协议只在服务端暂存端到端加密的请求/结果密文，
不上传正文、提示词、答案、私钥、模型或索引到同步实体或公开资讯 API。
