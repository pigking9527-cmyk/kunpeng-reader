# 契约测试样本

此目录存放脱敏、可长期复现的同步样本。每个样本要能说明：输入状态、一次 push/pull 后的预期状态，以及冲突/删除的处理结果。

首批场景应覆盖：

1. 两台设备对同一阅读进度的先后更新；
2. 高亮及其颜色、批注的创建和删除；
3. 标签、书单、书单排序与书单封面；
4. 删除墓碑不会被旧设备复活；
5. 账户级数据世代在云端清除后递增，旧世代写入被拒绝；
6. 永久删除账户同时删除全部从属记录。
7. 阅读桶按本地日期、小时和图书 ID 累加；有效重读可增加 `words`，不把它当作全书去重字数。
8. 客户端收到未知 `kind` 或未知 payload 字段时不会丢失已知数据。
9. `book_state_v2.progress_history` 缺失时按空数组处理；同一本地日的多个条目只保留 `at` 最大者，且客户端写回时保留已拉取历史与未知 payload 字段。
10. `core-data-package.v1.json` 可由迁移包 schema 读取，包含四种允许实体、一个墓碑和未知 payload 字段；不含图书文件、路径、密钥、AI 历史、cursor/ack 或 `data_generation`。
11. `sync-entity-clock-compatibility.v1.json` 说明旧 Android 合理 epoch 秒输入被服务端规范化为毫秒，而规范毫秒输入、cursor 与 `data_generation` 保持原值。
12. `ai-reader-history-retention.v1.json` 固定智读跨书合计 100 条、书库问答 100 条以及每类 200 条删除墓碑的协议 v1 兼容策略。
