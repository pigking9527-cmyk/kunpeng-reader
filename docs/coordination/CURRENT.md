# 当前跨端协作状态

> 只记录正在进行且会影响多个端的事实；不要把日常开发日志堆在这里。

**更新时间：2026-08-14**

## 工程方向

- ADR-0030 确定桌面端只维护一套产品 UI。当前主窗口、阅读、搜索、设置、账户、统计、资讯和书架均由 `ui/` 中的唯一原版实现承载；禁止候选 iframe、双轨 loader、隐藏备用 DOM 和“新版/旧版”切换。TypeScript 继续承载无视图状态、规则、controller 和 Tauri 边界。
- 除非用户明确要求改变视觉、布局或交互，否则重构、迁移和框架升级必须保持原版 UI；不得借技术迁移自行设计新界面。
- EPUB/PDF、分页、选区和手势保持独立的命令式阅读引擎；Rust 桌面端继续以 Tauri 2 为框架，不叠加第二套 Rust UI 框架。
- `apps/desktop-ui/` 只承载无视图业务边界和阅读 adapter 构建，`packages/tauri-api/` 是类型化 Tauri 边界，`packages/ui/` 提供隔离的设计变量。根目录可运行 `npm run lint`、`npm run typecheck`、`npm run test:typed`、`npm run test:legacy-ui` 与 `npm run desktop-ui:build`。
- 新会话的工程规则见 `docs/architecture/desktop-frontend-and-rust.md`；长期多会话迁移按 `docs/architecture/multi-agent-migration-program.md` 执行；正在进行的文件占用见 `docs/coordination/ACTIVE_WORK.md`。

## 协议基线

- `syncProtocolVersion`：**5（破坏性开发基线；同步请求必须显式声明协议 5）**。`readerJumpBackSizeLevel` 已永久退役；`app_settings_v1/default` 只接受必填的 30–160 px `readerJumpBackIconSizePx`，不读取、换算或镜像旧 1–10 级字段。
- Rust + Axum + SQLx + PostgreSQL 的 v5 服务与桌面 wire 语义已严格对齐：桌面只接受 Axum 的 camelCase v5 DTO，inventory、reconcile、密钥状态/重置、数据重置、资产、账户概览和邮箱绑定/换绑均已有对应端点与运行时兼容测试。该服务仍未部署或切换生产流量；受保护 PostgreSQL 的空库 migration、端到端、备份/恢复和反代演练完成前，禁止 v5 切流。最近一次受保护空库演练在容器镜像下载超时时于迁移前安全停止，临时库/角色/源码目录均已销毁，不能视为 E2E 证据。旧 Python 服务源码已移除；历史运行记录不能承接 v5 客户端，也不得被用作双写、协议翻译或可运行回滚路径。
- 同步范围可按本机逐项选择：阅读进度与续读位置、书签/高亮/批注/评分/用户标签/书单、生词本、阅读统计、软件设置、大模型书籍分类标签、自定义阅读主题与背景，以及智读配置、历史和加密密钥。关闭某项仅暂停该类交换，不删除任一端副本；重新开启会从头拉取该类数据。
- 不同步：图书正文/原文件、原始封面、语义模型、语义索引和本机路径。API Key/翻译凭据默认不同步；仅用户设置同步密码并开启密钥同步后，才以端到端加密密文同步。同步密码不可找回；忘记后通过服务端密钥包世代撤销旧密文，再以新密码重新加密。

## 发布状态与证据边界

| 对象 | 当前事实 | 不得据此作出的结论 | 升级为可发布状态的门禁 |
| --- | --- | --- | --- |
| 历史 Python 同步服务与其 SQLite/PostgreSQL 运行记录 | 已移除 Python 服务源码；只保留不可执行的 pre-v5 历史记录，不参与 v5 双写、协议翻译或回滚。 | 旧服务曾运行、历史 PostgreSQL 切换或旧客户端同步成功，均**不能**证明 Rust/Axum v5 已部署、可切流或已完成迁移。 | 不适用；它不是 v5 的兼容层、回滚实现或验收替代品。 |
| Rust + Axum + SQLx 的同步协议 v5 | 源码、桌面 wire、DTO 与本地运行时兼容测试已对齐；服务**尚未部署，也未承接生产流量**。 | 编译、单元/Router 测试、离线配置检查、产物溯源或迁移静态检查，均不能证明真实 PostgreSQL E2E、备份/恢复或反代切换已完成。 | 在受保护、可销毁的空 PostgreSQL v5 测试库完成 migration、桌面到 Axum 的认证/注册与同步 E2E、资产和恢复/数据清除；完成备份恢复及反代切换/回滚演练后，才可申请受控部署与切流。 |
| v5 部署、正式同步地址与公共发行 | 禁止切流；公共发行版不内置真实同步地址，未配置时应拒绝注册/登录。 | 不能因客户端声明协议 5、服务端接口齐全或已有自托管地址而宣称 v5 已上线。 | 上述 v5 演练全部留存有效证据，并完成受控部署、端到端注册验收与切换批准；之后才可由受控发行构建注入正式 HTTPS 地址。 |
| macOS 桌面包 | 当前仅为 Apple Silicon 开发/验收基线，使用临时签名。 | 本机安装或 CI 构建通过，不等于可公开发布的 macOS 安装包。 | 完成 Developer ID 签名、公证及干净机 Gatekeeper 安装验收；此外仍受许可证发布门禁约束。 |

- **证据规则**：只把在受保护实际环境完成且保留摘要证据的 migration、E2E、备份恢复、反代切换/回滚与签名/公证验收记为发布证据。离线检查、模拟 Router、静态 schema、编译和本机构建只证明相应的本地门禁通过。
- 最近一次受保护空库尝试在容器镜像下载超时时于迁移前安全停止，相关临时资源已销毁；该尝试不是 PostgreSQL E2E 或备份恢复证据。

## 平台状态

| 平台 | 状态 | 当前重点 |
| --- | --- | --- |
| Windows | 1.0.0 x64 新基线 | 单一桌面 UI + TypeScript 业务边界；NVIDIA 运行库再分发暂停，使用 CPU 回退。 |
| macOS | 1.0.0 Apple Silicon 新基线 | 与 Windows 使用同一桌面代码基线；当前为临时签名，后续补 Developer ID 签名与公证。 |
| Linux | 1.0.0 x86_64 新基线 | Ubuntu 24.04 CI 生成 AppImage/deb 和 SHA-256；NVIDIA 运行库再分发暂停。 |
| Android | v0.3.0 Profile 测试包已发布 | 新增全文与语义检索；当前为 Android Debug/Profile 签名，后续配置生产 keystore，并继续按 contracts 校验兼容性。 |
| iPhone / iPad | 启动阶段 | SwiftUI 书架、阅读页和 iPad 侧栏体验。 |

## 当前跨端工作项

- 许可证整改：`v1.0.0` 至 `v1.16.0` 的桌面发行物曾链接 GPL-3.0 `epub` 依赖；当前开发版已切换为 Apache-2.0 `rbook` + 本仓库兼容适配层，并移除 vendored GPL 源码。新增公开 Release 资产由许可证门禁暂停，直至解析兼容、发行包第三方声明、历史资产处置与法律复核完成；本机和 CI 验收构建继续运行。详见 `docs/legal/historical-release-license-audit.md`。
- 产品版本重置为 1.0.0；协议 v5 客户端只使用 `/v1/auth/*` 与 `/v1/sync/*`，同步请求发送 `X-Sync-Protocol-Version: 5`。v4、协议 3 或缺少版本声明的同步请求会收到 HTTP 426；公开源码不内置真实同步、更新服务或代码托管地址。

1. 为现有服务端 API 和同步实体补齐正式 schema、请求/响应 fixture 与兼容测试。
2. Android/iOS 先实现本地阅读、进度、高亮、书签、标签与书单；语义索引、智读和脑图不阻塞第一阶段。
3. 正式同步地址只能在已完成 v5 部署与端到端注册验收后由受控发行构建注入；当前公共发行版不内置地址，未配置时明确拒绝注册或登录。自托管用户已保存的地址仍优先；Android/iOS 将使用同一 HTTPS 端点，不得在生产版放开明文 HTTP。
4. 继续明确认证/Token 生命周期，并为将来从 IP 端点迁移到稳定域名准备兼容方案。
5. `model_book_tags_v1` 由 ADR-0004 定义：与用户手工标签分离且始终同步；书库问答始终使用它，“使用大模型分类的标签”仅控制本机问答范围筛选。旧客户端必须忽略但保留该可选实体。
6. ADR-0023 将智读/书库问答历史升级为 `ai_reader_history_entry_v2`：每条记录独立同步，读者历史 ID 为 `reader:<content-id>:<entry-id>`、书库问答 ID 为 `library:<entry-id>`；本机历史不设上限，云端两个 scope 各最多 100 条活跃实体及 200 条墓碑。`ai_reader_history_v1` 数组只读迁移，协议 v3 不再上传；仅同步问题、回答和脱敏来源索引，避免正文、本机 ID 或路径泄漏，也避免单条更新重复上传全量历史。
7. ADR-0006 定义三层破坏性操作：清除此设备、清除此设备及云端、永久删除账号。云端清除递增账户 `data_generation` 并撤销全部令牌；世代大于 1 后旧客户端不得写入，避免离线旧数据复活。
8. ADR-0007 定义 `reading_bucket_v2.words` 为有效阅读的累计字数，而非全书去重字数；满足停留和反刷量门槛的重读应再次计入。Android/iOS 后续需对齐该语义。
9. ADR-0008 定义反馈接口的可选 JSON 附件：仅 Bug 反馈可由用户主动选择 1 个 UTF-8 JSON，原始内容上限 256 KB；服务端必须通过 `acceptedAttachments` 明确确认接收，旧服务不得被客户端当作附件提交成功。
10. ADR-0009 记录既有 `book_state_v2.progress_history`：它是每日最后阅读位置摘要。各端应在本地日历日内取 `at` 最新条目、最多保留 3650 日；旧 payload 缺失该字段按空数组处理，写回时必须保留已拉取的历史与未知字段。
11. ADR-0010 定义离线核心状态迁移包 `kunpeng-reader-core-data-package` v1：仅迁移四种核心同步实体及其 LWW/墓碑元数据；不包含文件、路径、索引、密钥、AI 历史、`data_generation`、cursor 或 ack。各端实现前必须执行 schema 与资源上限校验，并在导入前创建本机恢复点。
12. ADR-0016 定义 `user_book_tags_v1` 与 `book_collections_v1`：独立实体存在时覆盖 `book_state_v2` 的兼容镜像，活跃空数组表示明确清空；旧客户端可继续同步阅读状态，但不能再以整包空字段清除标签或收藏夹。
13. ADR-0017 已废弃：产品不提供云端历史版本恢复；客户端与服务端不保留恢复入口或运行时历史，迁移会物理清理旧历史表。v5 服务的有界连接池、回环边界、最小权限、备份和健康监控要求仍必须在部署演练中验证；当前未部署，不得把旧 SQLite/Python 的运行记录表述为 PostgreSQL 证据。
14. ADR-0018/0020 定义 `reader_palette_v1` 与 `reader_palette_order_v1`：默认主题不上传；最多同步 10 个自定义主题。新客户端的背景图是独立二进制资产（本机缓存、SHA-256 引用、认证分块续传与 Range 下载），主题只保存 asset ID/MIME/摘要/尺寸；单图最大 5 MiB，超过上限的旧图不再支持；删除主题后持续七天未被任何活动主题引用的本机/云端图片才物理清理。旧 `backgroundImage` data URL 仅迁移兼容，绝不可进入阅读页 URL、postMessage 或动态 CSS。
15. ADR-0019 定义账户同步准入与滥用防护：新账号必须完成绑定邮箱验证才能调用同步 API；当前实体和同步资产计入 25 MiB 持久化存储预算，实际接受的实体写入计入每日 25 MiB / 10,000 条上传预算；拉取、断点恢复下载和新设备恢复不计入上传预算。IP/账号令牌桶、封禁审计与待告警记录保存在服务端共享数据库。
16. ADR-0021 保留 `app_settings_v1/default` 的历史同步边界；ADR-0031 在 v5 取代其中的 1–10 级兼容设计。v5 只接受 30–160 px 的必填 `readerJumpBackIconSizePx`，并拒绝/清理已退役的 `readerJumpBackSizeLevel`；其余菜单栏、资讯、书库问答、手势和阅读排版边界保持不变。未来未知字段仍保留，已退役字段除外。
17. ADR-0024 定义 `booklist_v1/<list_id>`：书单名称、简介、内容 ID 顺序、封面内容 ID 和逐书评语独立同步，成员关系继续由 `book_collections_v1` 权威保存；推荐书单先本地语义粗选，再把有限候选交给用户配置的大模型精选，模型不可推荐候选外图书。图书文件、路径、正文、封面缓存和索引均不进入该实体。
18. ADR-0029 保留 Rust 同步 API v4 的历史迁移记录；ADR-0031 将当前开发基线升级为 v5。Axum 与桌面完整 wire 已对齐；受保护 PostgreSQL E2E 和完整切换/回滚演练完成前，v5 不得部署；已移除的 Python 服务不是 v5 兼容层或回滚实现。

## 开工提醒

开始跨端任务前：阅读根目录 `AGENTS.md`、本文和相关 `contracts/`。若修改实体语义或 API，先写 ADR 与契约；若仅改本端 UI，不必等待其他端。
