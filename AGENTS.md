# 鲲鹏阅读器协作规则

本文件适用于在本仓库工作的所有 Codex 会话、人工开发者与 CI。开始任何任务前，先阅读本文件、`docs/coordination/CURRENT.md`，以及与任务有关的 `contracts/` 文档。

## 1. 仓库与平台边界

- 当前仓库以桌面端为主：Rust + Tauri + Web UI，服务端代码位于 `server/reader-sync-api/`。
- 长期目标是单 GitHub 单仓库管理 Windows、macOS、Linux、Android、iOS 与 iPadOS；各端**不要求共用 UI 代码**。
- 在用户明确迁移前，不移动现有桌面目录，也不擅自把外部 Android/iOS 工程复制进来。移动端工作可先引用本仓库的 `contracts/` 和 `docs/`。
- 跨端唯一事实来源是：`contracts/`（数据与协议）、`docs/architecture/`（行为规则）、`docs/adr/`（已决定的取舍）。不要以某个客户端的 SQLite 表结构作为协议。

## 2. 开工与收尾

1. 先查看 `git status --short`；保留并避开其他人的未提交修改。
2. 拉取可安全合并的最新提交：`git pull --ff-only`。若不能快进，不强行 reset 或覆盖。
3. 阅读 `docs/coordination/CURRENT.md`，确认当前协议版本、跨端变更与阻塞项。
4. 完成后说明：修改范围、是否改动契约、验证命令及仍未验证事项。

## 3. 变更分级

### 本端 UI 变更

例如按钮位置、颜色、iPad 分栏布局、Android 页面动效。只需更新本端代码和本端测试；通常不需要修改跨端契约。

### 跨端语义变更

例如阅读位置含义、高亮/批注字段、书签、标签、书单、评分、统计、删除语义、同步冲突、认证 API。

这类变更必须按以下顺序进行：

1. 在 `docs/adr/` 新增或更新决定记录；
2. 更新 `contracts/` 的 schema、说明和 fixture；
3. 补兼容性用例；
4. 保持服务端对上一个协议版本向后兼容，除非用户明确批准破坏性升级；
5. 各端按契约实施，不得自行发明同义字段。

### 破坏性变更

不得静默复用旧字段表达新含义。必须升级 `syncProtocolVersion`，写迁移与回滚说明，并在 `CURRENT.md` 标记未升级客户端的处理方式。

## 4. 共享数据原则

- 图书正文、原始书文件、原始封面、语义模型、语义索引不进入同步实体。
- 同步实体至少具备稳定 `id`、`kind`、`updated_at`、`deleted_at`、`device_id`、`sync_version` 或等价冲突信息。
- 删除使用墓碑语义，不能用“服务器未返回”推断删除。
- 客户端必须能处理未知字段；服务端应尽量保留未知实体/字段，避免旧端覆盖新端数据。
- API Key、密码、Token、用户本机路径与私密阅读内容不得进入 fixtures、日志、Git 或 GitHub Issue。

## 5. 测试与发布

- 改动桌面端后按风险运行 `scripts/check.ps1`；发布前运行 `scripts/check.ps1 -Release`。
- 改动 `contracts/` 时，至少验证 JSON schema、fixtures 和服务端请求/响应兼容；未来每个平台都必须运行同一套兼容性测试。
- 单个平台构建失败不能阻塞其他端的日常开发，但不能把失败产物标记为正式 Release。
- 用户可见版本、各端构建版本与同步协议版本分开管理；不要因为某端补丁而无故升级所有端版本。

## 6. 会话之间如何通气

- 不要依赖聊天记忆作为交接；以 Git 提交、`CURRENT.md`、ADR 和 contracts 为准。
- 纯 UI 改动无需通知其他会话。
- 影响共享语义的变更必须先提交契约和 ADR；其他会话下一次开工时读取这些文件即可获得更新。
- 一个已经长时间运行的旧会话不会自动刷新上下文；此时只需通知它一次：“请先 pull 并重新阅读 AGENTS.md、CURRENT.md 和相关 contracts。”
