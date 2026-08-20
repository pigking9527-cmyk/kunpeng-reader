# 鲲鹏阅读器协作规则

本文件适用于在本仓库工作的所有 Codex 会话、人工开发者与 CI。开始任何任务前，先阅读本文件、`docs/coordination/CURRENT.md`、`docs/coordination/ACTIVE_WORK.md`，以及与任务有关的 `contracts/` 文档。

## 私有运维资料

- 涉及鲲鹏阅读器的服务器操作前，先读取仓库外的 `~/.codex/private/kunpeng-reader.md`。
- 该文档包含服务器连接与部署资料；不得将其内容复制到仓库、Git、GitHub、Issue、PR、日志、测试 fixture、发布说明或用户可见输出。

## 1. 仓库与平台边界

- 当前仓库以桌面端为主：Rust + Tauri + Web UI；同步服务端代码位于 `server/reader-sync-api-rs/`。
- 长期目标是单 GitHub 单仓库管理 Windows、macOS、Linux、Android、iOS 与 iPadOS；各端**不要求共用 UI 代码**。
- 在用户明确迁移前，不移动现有桌面目录，也不擅自把外部 Android/iOS 工程复制进来。移动端工作可先引用本仓库的 `contracts/` 和 `docs/`。
- 跨端唯一事实来源是：`contracts/`（数据与协议）、`docs/architecture/`（行为规则）、`docs/adr/`（已决定的取舍）。不要以某个客户端的 SQLite 表结构作为协议。

## 1.1 UI 单一实现与视觉保护

- 除非用户明确要求改变 UI 视觉、布局或交互，否则任何重构、迁移、类型化、性能优化和框架升级都必须保持现有页面的外观与行为，不得自行重新设计。
- 产品 UI 始终只有一套用户可达实现。不得为候选方案、技术迁移、实验、兼容或回退另写第二套页面、第二套组件树或第二套样式，也不得加入新旧 UI 切换入口、隐藏备用 DOM、双轨 loader 或候选 iframe。
- 技术栈迁移只能替换实现方式，不能默认获得改版授权。若无法在保持原版视觉与交互的前提下完成迁移，必须停止相关 UI 写入并先向用户确认。
- 用户明确要求恢复原版 UI 时，必须删除自行新增的替代 UI，不得把它作为隐藏页面、实验代码或备用入口保留在产品源码中。

## 2. 开工与收尾

1. 先查看 `git status --short`；保留并避开其他人的未提交修改。
2. 拉取可安全合并的最新提交：`git pull --ff-only`。若不能快进，不强行 reset 或覆盖。
3. 阅读 `docs/coordination/CURRENT.md`，确认当前协议版本、跨端变更与阻塞项。
4. 涉及桌面 UI、TypeScript、React、Rust 架构或构建链时，阅读 `docs/architecture/desktop-frontend-and-rust.md`、`docs/architecture/multi-agent-migration-program.md` 与 ADR-0025。
5. 修改多个文件、共享契约或原生层前，在 `docs/coordination/ACTIVE_WORK.md` 登记占用范围；不得与已有占用静默重叠。
6. 完成后说明：修改范围、是否改动契约、验证命令及仍未验证事项，并清理或更新自己的占用登记。

## 2.1 本机问题记录排查

- 应用会把最新两分钟的脱敏问题快照覆盖写入 `profile::app_cache_dir()/problem-trace-latest.json`，并把性能与后端运行日志写入同目录的 `debug.log`；macOS 默认位置是 `~/Library/Caches/ebook-reader/`。这些文件是本机诊断数据，不得加入 Git、Issue、PR、fixture 或发布物。
- 用户说“问题已记录”、“查下数据”或要求排查本机已复现问题时，新会话应先直接读取上述最新快照和日志，再根据 `captured_at`、章节/页码和性能事件截取同一次运行；只有文件缺失、损坏或时间明显不匹配时，才请用户手动保存问题记录。
- 排查时不得回显或复制书籍正文、账户数据、凭据、路径等未脱敏内容；诊断数据不足时应先扩充允许列表内的状态或时序指标，不得改为记录原文或敏感输入。

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
- macOS 构建验证通过后，只能使用 `scripts/install-macos-app.sh` 覆盖并启动 `/Applications/鲲鹏阅读器.app`；不得直接启动构建目录中的 `.app`，也不得创建、更新或依赖桌面“验收版”应用。
- 私密运维资料不得进入仓库、PR、Issue、Release Notes 或日志。真实服务器地址、账户、SSH 身份文件位置、远端路径、密码、Token 和交接资料一律存放在仓库外；详细流程见 `docs/security/repository-safety.md`。
- 提交前必须安装 `.githooks/pre-commit`（执行 `scripts/install-git-hooks.ps1`）；发布暂存只能通过 `scripts/stage-release.ps1 -Path ...` 的明确白名单完成，禁止 `git add -A`、`git commit -a` 和“暂存全部”。
- 发布服务器参数只能通过命令行或 `KUNPENG_RELEASE_*` 环境变量提供；不得将真实值提交到脚本默认参数。
- 服务容量测试必须复用 `server/reader-sync-api-rs/scripts/capacity-k6.js`、`capacity-k6-report.py`、`capacity-client-monitor.py` 与 `capacity-monitor.py`：容量测试总时长固定 20 分钟，依次为基线 5、提高 75、峰值 150、压力 200、压力 250、压力 300、压力 350、压力 400、压力 450、压力 500、恢复 25 并发；第 4 阶段后逐步提高压力，500 并发是最高压力，只有用户明确要求的非容量冒烟才可缩短。压测使用至少 2048 个独立的可销毁测试账户，且同一时刻的 VU 必须落到不同账户、低并发阶段轮换覆盖整个账户池，避免把单账户准入或写入串行保护误测为服务容量；客户端必须与 API/数据库分机部署；每次报告并保留各阶段请求混合、并发数、状态码/无响应、P50/P95/P99，以及客户端、API 进程与 PostgreSQL 的 CPU/RSS/可用内存。测试库必须是受保护、可销毁且名称符合前缀门禁的 PostgreSQL 库；严禁对生产库压测。
- 用户要求“带数据短测”时，复用 `server/reader-sync-api-rs/scripts/run-capacity-test.sh --bulk-data-smoke`，它是固定 **300 秒**的非容量数据路径冒烟：从至少 2048 个可销毁账户的 fixture 池中选取低频独立账户，以约 256 KiB、不可压缩的同步实体交替执行 push 与 cursor=0 pull；同一实体持续更新，不能无界累积测试数据。报告必须同时包含实际上传/下载字节、按操作的 2xx/4xx/5xx/无响应、P50/P95/P99、API/PostgreSQL/压测机 CPU、RSS 与可用内存。该结果只能说明大实体传输路径，不得外推为 20 分钟小请求容量或真实书籍/原文件上传能力；仍只能命中隔离测试服务和可销毁数据库。
- 默认只允许 localhost 隧道目标；若隧道无法承载测试并改用直连，必须额外传入 `--allow-external-test-target`。云防火墙可常驻一条仅允许指定压测机当前公网 `/32` 访问固定测试端口的规则。当前开发阶段若用户明确授权，独立测试服务、主机放行和该 `/32` 白名单可以保留供一键复测；公网地址变化时先更新云侧白名单。无论何时都不得把测试端口接入反代或公开放行。
- 改动 `contracts/` 时，至少验证 JSON schema、fixtures 和服务端请求/响应兼容；未来每个平台都必须运行同一套兼容性测试。
- 单个平台构建失败不能阻塞其他端的日常开发，但不能把失败产物标记为正式 Release。
- 用户可见版本、各端构建版本与同步协议版本分开管理；不要因为某端补丁而无故升级所有端版本。

## 6. 会话之间如何通气

- 不要依赖聊天记忆作为交接；以 Git 提交、`CURRENT.md`、ADR 和 contracts 为准。
- `ACTIVE_WORK.md` 是未完成任务的文件占用表；`CURRENT.md` 只记录跨端当前事实，二者都不是长期设计文档。
- 纯 UI 改动无需通知其他会话。
- 影响共享语义的变更必须先提交契约和 ADR；其他会话下一次开工时读取这些文件即可获得更新。
- 一个已经长时间运行的旧会话不会自动刷新上下文；此时只需通知它一次：“请先 pull 并重新阅读 AGENTS.md、CURRENT.md 和相关 contracts。”
