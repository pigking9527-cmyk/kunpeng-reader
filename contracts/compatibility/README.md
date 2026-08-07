# 兼容性断言

每个客户端和服务端最终都应验证以下最小约束：

1. 可以读取 `fixtures/core-entities.v1.json`；
2. 不会因未知 payload 字段失败；
3. 不会把 `deleted_at` 非空的实体当作活跃实体；
4. 写回时保留实体 ID、kind 与版本信息；
5. 不会把本机 API Key、Token、书籍原文混入同步 payload。
6. 账户 `data_generation` 大于 1 时拒绝缺失或不匹配世代的写入，并保证云端清除后旧设备不能复活实体。
7. 删除账号后，账户及其令牌、同步实体、邮箱验证和世代记录均不存在。
8. 可以读取 `book_state_v2` 缺失 `progress_history` 的旧 payload，并把它视为无历史；拉取包含该字段的 payload 后，按本地日历日合并并仅保留每日本地时间最新的条目（最多 3650 日）。
9. 客户端随后写回 `book_state_v2` 时，不会把已拉取的 `progress_history` 改写为空数组，也不会删除未知 payload 字段。
10. 可以读取 `fixtures/core-data-package.v1.json`，并只接受 schema 所列四种实体；包内 LWW 元数据与 `deleted_at` 墓碑必须参与合并。
11. 导入迁移包不得修改本机 `data_generation`、同步 cursor、sync acknowledgement 或认证状态；不得从包中接受图书文件、路径、正文、索引、API Key、Token、密码、AI 历史或 `secret_bundle_v1`。
12. 对迁移包必须在解析前/后执行 ADR-0010 的 16 MiB、50,000 实体、深度、单实体和字段资源限制；超限时整个导入失败且不部分写入。
13. 同步实体响应中的 `updated_at` 与 `deleted_at` 必须是 Unix epoch 毫秒，活跃实体的 `deleted_at` 为 `0`；服务端须兼容合理 epoch 范围内旧 Android 发来的秒级值并规范化后参与 LWW，且不得转换 `cursor`、`server_updated_at` 或 `data_generation`。

待真实服务端字段完成逐项对齐后，这里会补每个端可直接运行的断言脚本。
