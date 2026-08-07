# 核心状态迁移包

`core-data-package.schema.json` 定义跨设备、离线迁移的核心同步状态包。它不是恢复点、SQLite 导出或服务器同步请求。

- 只允许 `book_state_v2`、`model_book_tags_v1`、`vocab`、`reading_bucket_v2`；
- 保留 LWW 元数据和墓碑；
- 不含图书文件、正文、封面、路径、索引、密钥、AI 历史或同步运行状态；
- 格式和资源限制见 ADR-0010。

实现必须先验证本 schema，再执行 ADR-0010 中无法由 JSON Schema 表达的字节数、深度和序列化大小限制。
