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
14. `sync-recovery-history.v1.json` 固定完整变化实体压缩、90 天锚点、恢复世代、密钥包排除，以及 7 日/4 周/12 月整库压缩快照策略。
15. `reader-palettes.v1.json` 固定自定义阅读配色按主题独立 LWW、排序实体、最多 10 个自定义主题及 10 MiB 原始背景图上限；默认主题不上传。
16. `app-settings.v1.json` 固定 Windows、Linux、macOS 共享的非敏感软件设置实体、跳转回退图标 30–160 px 大小与保留的 1–10 级兼容镜像、主窗口菜单栏的 28–52 px 尺寸/完整排序/可选隐藏（设置不可隐藏）以及图标和文字的显示/内部顺序、资讯来源与自定义贴吧选择、书库问答偏好、最多 24 条自定义手势（每条 48 个归一化轨迹点）及提示设置。`profilesInitialized: true` 固定空手势列表为明确清空，旧的无标记空列表则保留迁移兼容；同时验证全局阅读排版/分页偏好与未知字段保留。
17. `ai-reader-history-entry.v2.json` 固定协议 v3 的逐条智读/书库问答实体 ID、旧数组迁移、100 条活跃和 200 条墓碑限制，以及来源脱敏边界。
