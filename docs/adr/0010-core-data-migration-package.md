# ADR-0010：核心同步状态迁移包

## 状态

已接受。

## 背景

桌面端曾提供仅供本端使用的数据包导入/导出。移动端需要安全地迁移可同步的阅读状态，但不能把某个客户端的 SQLite、恢复点或本机文件布局误当成跨端协议。

恢复点与迁移包不同：恢复点可包含同一安装的私有数据库和图书副本；迁移包只能包含可携带的核心同步实体。

## 决定

定义新的 JSON 格式 `kunpeng-reader-core-data-package`。格式版本 **1** 为既有 `book_state_v2` 迁移包；当前导出格式为 **2**，schema 位于 `contracts/migration/core-data-package.schema.json`。不得复用或放宽旧桌面 `kunpeng-reader-data-package` 的隐式 v2 解析规则。

v1 迁移包只允许以下四种实体：

- `book_state_v2`；
- `model_book_tags_v1`；
- `vocab`；
- `reading_bucket_v2`。

v2 迁移包将原先的 `book_state_v2` 拆为：

- `reading_progress_v1`；
- `reading_data_v1`；
- `reading_statistics_v1`；
- `model_book_tags_v1`；
- `vocab`；
- `reading_bucket_v2`。

顶层 `exported_at` 是 Unix epoch **毫秒**。每个实体必须保留 `kind`、`id`、`data`、`updated_at`、`deleted_at`、`device_id` 和 `sync_version`；其中时间字段同为 Unix epoch 毫秒。导入按既有 LWW 比较规则合并；`deleted_at > 0` 是墓碑，必须优先阻止旧活跃数据复活。包内和本机的未知 payload 字段必须原样保留，不能因迁移而删除。

### 严格解析边界

实现必须在解析前检查未压缩 JSON 文件不超过 **16 MiB**，并在解析/校验时强制：

- 最多 50,000 个实体；
- JSON 最大嵌套深度 64；
- 每个实体序列化后最多 256 KiB；
- `id` 最多 512 UTF-8 字节，`device_id` 最多 256 UTF-8 字节；
- payload 中单个字符串最多 64 KiB、对象最多 512 个直接字段、数组最多 10,000 项。

超限、未知顶层字段、未知实体种类、无效时间/version、非法 UTF-8 或非对象 payload 必须使整个导入失败；不得静默截断或部分导入。schema 能表达的结构限制由 schema 验证，字节数、递归深度和序列化大小由流式读取/解析器预检执行。

### 显式排除

迁移包不得包含：图书正文或原文件、封面、缩略图、语义模型/向量/索引、任何本机路径或 SAF URI、同步 cursor/ack、账户 `data_generation`、认证 Token、API Key、密码、`secret_bundle_v1`、AI/翻译配置或 AI 历史。

导入不得写入或重置本机的 `data_generation`、同步 cursor、同步 acknowledgement 或账号认证状态；这些状态只能由对应的同步/认证协议维护。实现必须拒绝带有这些顶层或实体字段的包，不能把它们当作未知字段保存。

### 事务、恢复与互操作

导入前必须创建本机恢复点。所有实体的校验、LWW 合并与本机物化必须处在可回滚的事务/安装边界内；任一步失败时保持导入前状态，并保留恢复点供用户显式恢复。导入后的实体按“来自外部迁移包、尚未得到当前账号服务端确认”处理，不能伪造 cursor/ack 或绕过下一次正常 pull-before-push。

格式版本 1 是 `syncProtocolVersion: 1` 的可选离线迁移格式；格式版本 2 对齐拆分后的桌面同步实体。两者都不改变服务端 API；客户端必须只接受显式支持的版本，而不是按普通 JSON 猜测解析。若导入实现出错，恢复到导入前恢复点即可回滚，不修改云端数据。

## 验证

各端必须通过 schema fixture，并覆盖：活跃实体与墓碑 LWW、未知 payload 字段保留、包大小/实体数/字段上限拒绝、排除字段拒绝、以及导入后 `data_generation`/cursor/ack 不变。
