# 同步实体约定

客户端服务入口见 [`api-base-v1.md`](api-base-v1.md)。当前仅 `/v1/auth/*` 与
`/v1/sync/*` 承载认证和同步；无需客户端世代请求头。这不改变实体的 `syncProtocolVersion`。

所有同步实体应具备稳定 ID、实体种类、更新时间、删除墓碑、来源设备和版本/冲突信息。实体内容按 `kind` 区分，客户端应忽略自己不认识的可选字段。

## 实体时钟

`updated_at` 与 `deleted_at` 的规范单位均为 Unix epoch **毫秒**；活跃实体的 `deleted_at` 为 `0`，墓碑使用删除时的毫秒值。LWW 依次比较 `updated_at`、`sync_version`、`device_id`。`server_updated_at`、pull cursor 与 `data_generation` 是独立服务端字段，不能被客户端当作实体时钟或做单位转换。

为兼容现实旧 Android，服务端仅在 `/v1/sync/push` 与 `/v1/sync/reconcile` 接受落在 2000-01-01 至 2100-01-01 合理 epoch 范围内的旧秒级 `updated_at`/非零 `deleted_at`，并在比较、存储和响应前规范化为毫秒；客户端不得继续产生秒级新值。合成测试时间戳（例如 `100`）不属于兼容范围，按原数值处理。完整迁移与回滚边界见 ADR-0011。

当前最小实体范围（协议 v5；其中部分实体名保留其历史版本号）：

- `reading_progress_v1`：按图书内容 ID 保存阅读位置、续读锚点和每日 `progress_history`；可单独停用同步。
- `reading_data_v1`：按图书内容 ID 保存书签、高亮、批注与评分；可单独停用同步。
- `reading_statistics_v1`：按图书内容 ID 保存累计阅读秒数、阅读字数与完成时间；可单独停用同步。`reading_bucket_v2` 仍保存小时级阅读统计，和本实体同属“阅读统计”开关。
- `book_state_v2`：仅作为本机升级时的旧数据种子保留，协议 v2 不上传、不下载、不作为权威来源。
- `user_book_tags_v1`：按图书内容 SHA-256 保存用户手工标签。独立实体存在时始终权威；活跃空 `tags` 数组表示用户明确清空，旧 `book_state_v2.tags` 不能覆盖它。
- `book_collections_v1`：按图书内容 SHA-256 保存收藏夹/书单成员关系。独立实体存在时始终权威；活跃空 `collections` 数组表示用户明确清空，旧 `book_state_v2.collections` 不能覆盖它。
- `booklist_v1`：一份书单的稳定 ID、名称、简介、按内容 ID 排列的项目、封面引用和逐书评语。成员关系仍以 `book_collections_v1` 为准；不含书籍文件、路径、封面缓存、正文或索引。
- `vocab`：生词本。
- `reading_bucket_v2`：按本地日期、小时和图书内容 ID 聚合阅读时长（`secs`）与有效阅读字数（`words`）。`words` 是累计阅读量，不是去重后的图书字数；满足平台停留与反刷量门槛的重读必须再次累加，因此它可以大于图书总字数。
- `model_book_tags_v1`：按图书内容 SHA-256 保存的大模型书目维度标签；与用户手工 `tag` 独立，可单独停用同步。

可选同步分类：

- 每一类均是**本机交换范围**：关闭时不上传、不下载、不生成墓碑，也不删除本机或云端副本；重新开启后客户端从头拉取，以恢复该类云端数据。
- `user_book_tags_v1`、`book_collections_v1` 和 `booklist_v1` 归入“书签、高亮、批注、评分、标签、收藏夹与书单”；`reader_palette_v1` 与 `reader_palette_order_v1` 归入“自定义阅读主题与背景”；`app_settings_v1` 归入“软件设置”。

可选私密扩展：

- `ai_reader_config_v1`：智读服务商、接口地址和模型名，不含 API Key；默认同步。
- `translation_config_v1`：翻译服务的非敏感偏好，不含凭据；默认同步。
- `ai_reader_history_entry_v2`：一条智读或书库问答历史对应一个同步实体。单书 ID 为 `reader:<content-id>:<entry-id>`，书库 ID 为 `library:<entry-id>`；本机历史不设活跃记录上限，云端读者历史和书库问答各最多 100 条活跃实体与 200 条墓碑。`off`、`recent`、`manual` 只决定本机哪些条目物化；新增、修改或删除一条记录只交换该实体。只同步问题、回答和脱敏来源书名/章节/材料类型，不同步书籍原文片段、本机 `bookId` 或路径。`ai_reader_history_v1` 仅作为旧云端数组的只读迁移来源，协议 v3 客户端不再上传它；完整规则见 ADR-0023。
- `secret_bundle_v1`：客户端加密后的 API Key/翻译凭据包；由用户设置同步密码后明确开启。
- `reader_palette_v1`：一个用户自定义阅读配色。每个主题单独使用 LWW 与删除墓碑同步，最多 10 个活跃主题；新客户端只保存 `backgroundAssetId`、SHA-256、MIME 与字节数，二进制图片通过认证的 `/v1/sync/assets/*` 分块通道传输并缓存为本机 reader 资源。`backgroundImage` data URL 仅为旧客户端迁移期的可读兼容字段；新客户端不得写入、不得放进阅读 URL、postMessage 或动态 CSS。默认主题不作为实体上传。
- `reader_palette_order_v1/default`：用户主题顺序。它仅保存当前默认主题与自定义主题的稳定 ID 排列；未知 ID 必须忽略。
- `app_settings_v1/default`：Windows、Linux、macOS 共用的账户级非敏感软件设置。`epubLayoutEngine` 可选值为 `legacy` / `modern`，缺失或非法时按 `legacy` 处理，仅影响 EPUB，详见 ADR-0033。跳转回退图标只使用 30–160 px（步进 1）的整数 `readerJumpBackIconSizePx`，位置 `readerJumpBackPositionX/Y` 为 0–1000 的图标左上角可见轨道比例；`readerJumpBackSizeLevel` 已由协议 v5 永久退役，出现该字段或缺失像素字段的 payload 均不得进入 v5 同步。其余资讯、书库问答、菜单栏、手势和全局阅读排版字段保持本段既有边界；已知字段按字段补丁合并并保留未来未知字段，但“保留未知字段”不适用于已退役的大小级别字段。首次接入账户时，云端的该实体优先于 WebView 启动期写入的本机默认值。完整断代、切换与回滚条件见 ADR-0031。

## 账户同步准入与资源预算

- 新注册账号可登录并在“账户安全”绑定邮箱；只有成功验证绑定邮箱后才可调用任何 `/v1/sync/*` 接口。未验证时服务端返回 `403 EMAIL_VERIFICATION_REQUIRED`；客户端必须引导用户完成验证而不是把本机数据丢弃。
- 已登录账户的首个邮箱绑定与旧/新邮箱两阶段换绑，见 [`../auth/email-binding-v1.md`](../auth/email-binding-v1.md)。这些认证请求不携带同步协议 header；换绑授权码是短时一次性机密，不能进入任何同步数据或持久化客户端状态。
- 被后台封禁的账号返回 `403 ACCOUNT_DISABLED`；封禁会撤销已有同步令牌。
- 服务端按账号限制存储总量和每日实际接受写入量。当前实体 JSON 与用于误操作恢复的压缩历史均计入存储；被拒绝、重复或 LWW 冲突的实体不消耗每日额度。超额实体在支持 disposition 的请求中返回 `QUOTA_EXCEEDED`。
- 已登录客户端可调用 `GET /v1/auth/usage` 查看自己的汇总额度：`storageBytes/storageLimitBytes`、`dailyWrittenBytes/dailyWriteLimitBytes`、`dailyEntityWrites/dailyEntityWriteLimit` 与 `dailyResetAt`。该端点不返回实体、历史内容、其他账号或认证资料；客户端以它为账户概览的事实来源。
- API 入口还会返回 `429 RATE_LIMITED` 和 `503 SERVER_BUSY`。客户端必须保留待同步本地变更，并在 `Retry-After` 后退避重试。
## 账户找回与私密密钥包

- 登录密码只能通过账户已验证的绑定邮箱重置；服务端保存密码哈希与一次性令牌摘要，不保存明文密码或验证码。
- `secret_bundle_v1/default` 的 JSON 是端到端加密信封。信封必须含 `epoch`，其值必须等于服务端 `/v1/sync/secret-state` 返回的 `secretBundleEpoch`。
- 用户遗忘同步密码时，客户端调用 `/v1/sync/secret-state/reset`。服务端递增世代、写入旧密钥包墓碑；任何旧 `epoch` 的上传必须以服务端墓碑冲突返回，避免离线旧设备复活旧密文。
- 同步密码不可找回；仍持有本机 API Key 的设备可用新密码重新加密并上传当前世代包。

账户级清除与删除见 [`account-data-lifecycle.md`](account-data-lifecycle.md)。云端数据清除使用只增不减的 `data_generation` 并撤销全部令牌；世代大于 1 后，旧客户端或旧世代写入必须被拒绝，不能让其他设备复活已清空的数据。
云端误覆盖恢复见 [`recovery-history.md`](recovery-history.md)，API 对象结构见 [`recovery.schema.json`](recovery.schema.json)。服务端只为实际接受的变化保存压缩完整实体版本，保留 90 天滚动窗口和窗口前锚点；恢复成功后递增 `data_generation` 并撤销全部令牌。`secret_bundle_v1` 不参与时间回滚，主动云端清除和账号删除同时物理删除恢复历史。

`entities.schema.json` 是契约抽取时的结构底座，不代表已替代服务端运行时校验。协议 v5 的服务端运行时也必须拒绝已退役字段；这是明确授权的破坏性升级，不提供旧客户端兼容层。
