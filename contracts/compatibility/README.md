# 兼容性断言

每个客户端和服务端最终都应验证以下最小约束：

1. 可以读取 `fixtures/core-entities.v1.json`；
2. 不会因未知 payload 字段失败；
3. 不会把 `deleted_at` 非空的实体当作活跃实体；
4. 写回时保留实体 ID、kind 与版本信息；
5. 不会把本机 API Key、Token、书籍原文混入同步 payload。

待真实服务端字段完成逐项对齐后，这里会补每个端可直接运行的断言脚本。
