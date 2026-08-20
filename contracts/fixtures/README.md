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
10. `core-data-package.v1.json` 覆盖旧迁移包兼容；`core-data-package.v2.json` 覆盖当前拆分后的进度、阅读数据、统计、模型标签、生词与阅读桶实体。两者均包含墓碑和未知 payload 字段，且不含图书文件、路径、密钥、AI 历史、cursor/ack 或 `data_generation`。
11. `sync-entity-clock-compatibility.v1.json` 说明旧 Android 合理 epoch 秒输入被服务端规范化为毫秒，而规范毫秒输入、cursor 与 `data_generation` 保持原值。
12. `ai-reader-history-retention.v1.json` 固定本机智读与书库问答历史不限条数、云端每类最多 100 条、每类 200 条删除墓碑，以及书库问答的 `off`/`recent`/`manual` 同步策略。
13. `independent-book-organization.v1.json` 固定用户标签与收藏夹独立实体，以及旧 `book_state_v2` 空数组不得覆盖独立实体的兼容规则。
14. `reader-palettes.v1.json` 固定自定义阅读配色按主题独立 LWW、排序实体、最多 10 个自定义主题及 5 MiB 背景资产上限；默认主题不上传。
15. `app-settings.v1.json` 是协议 v5 的破坏性基线：固定 Windows、Linux、macOS 共享的非敏感软件设置实体与 30–160 px 的 `readerJumpBackIconSizePx`；不含、也不得添加已退役的 `readerJumpBackSizeLevel`。它同时覆盖菜单栏、资讯、书库问答、手势、阅读排版和未来字段保留；未来字段保留不涵盖被 v5 明确退役的字段。
16. `ai-reader-history-entry.v2.json` 固定协议 v3 的逐条智读/书库问答实体 ID、旧数组迁移、100 条活跃和 200 条墓碑限制，以及来源脱敏边界。
17. `email-binding-api.v1.json` 固定经过认证的邮箱绑定/换绑 route、请求字段名、成功状态和非敏感响应形状；它刻意省略邮箱、验证码、Bearer Token 与一次性 `rebindGrant` 的实际值。
19. `phone-registration-api.v1.json` 固定 E.164 手机号两阶段注册、供应商接受投递门禁、5 分钟/5 次验证码边界和非敏感响应形状；它刻意省略完整手机号、验证码、密码和短信密钥。
20. `sync-checkpoint.v1.json` 固定可选的认证 checkpoint 请求、generation/cursor 高水位响应与 false/409 回退边界；不含 Bearer Token 或实体内容。
21. `sync-handoff-and-subscriptions.v1.json` 固定跨设备续读只交换稳定内容标识，以及自定义 RSS/Atom 地址必须由用户单独开启后才同步；两者均不包含书籍文件、路径、正文或资讯缓存。
