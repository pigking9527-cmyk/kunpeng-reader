# 鲲鹏阅读器 Android 工作交接

> 更新：2026-08-06。本文是下一位 Android 开发者的起点，不是发布说明。先读仓库根目录 `AGENTS.md`、`docs/coordination/CURRENT.md`、`docs/architecture/跨平台协作规则.md` 和 `contracts/README.md`；涉及同步、账号或删除语义时，以 `contracts/`、服务端实现和 fixture 为准。

## 1. 当前工程与版本

Android 是独立 Flutter 工程，**不在本仓库目录内**：

```text
C:\Users\pigki\Documents\Codex\2026-07-21\claude-projects\kunpeng-reader-mobile
```

不要继续修改历史快照 `kunpeng-reader-mobile-release-v1.9.5`。本次核对时有效工程状态如下：

| 项目 | 当前值 |
| --- | --- |
| Git 分支 / HEAD | `main` / `760488792d92885d3d1b297b718571413a7117d2` |
| 工作区 | 干净（核对时无未提交修改） |
| Android 客户端版本 | `0.3.0+3`，来自 `pubspec.yaml` |
| Android applicationId | `com.pigking.kunpeng_reader_mobile` |
| 产品 Release 关联号 | 默认 `1.11.0`，仅用于读取同一 GitHub 产品 Release 元数据；不可与 Android 版本混用 |
| 正式同步默认地址 | `https://117.72.220.69` |
| 当前发布性质 | v0.3.0 Profile 测试包；尚未配置生产签名 keystore |

桌面端是 Rust + Tauri；Android 是 Flutter/Dart + Material UI + Android WebView。两端共享的是产品语义、同步协议与测试样本，**不共享桌面 UI 或 SQLite 表结构**。

## 2. 已实现范围（代码已存在，仍需持续真机验收）

### 书架、导入与本地数据

- EPUB/TXT 解析、导入、封面提取、书架网格/列表、筛选、排序、长按多选和批量操作。
- SAF 多选导入后把文件复制到应用私有目录，原始来源 URI 不作为长期阅读依赖。
- 本地 SQLite 保存书目、阅读状态、用户数据、全文索引和同步状态；启动快照、最近阅读缓存、封面/索引维护被放到首屏之后执行。
- 全书架正文检索、按书分组的结果页、命中片段和点击回到阅读位置。
- 语义索引页与“关键词 / 语义”切换：BGE Small 中文 v1.5 模型、正文切块和向量索引只保留本机。
- 自动导入支持多个目录；入口在常用设置的“启用自动导入”开关和齿轮页。手动导入始终可用。

### 阅读器

- EPUB/TXT 竖屏阅读、目录、章节跳转、章节预热、阅读位置恢复、进度横条跳转和恢复跳转前位置。
- 点击中部显示/隐藏阅读工具栏与底部进度条；点击/滑动翻页、滚动阅读与章节边界处理均已有实现。
- EPUB 图片、章节页头、脚注标记和脚注弹层；脚注二次点击应收起。
- 文本选择、高亮、批注、书签、高亮颜色、横排/九宫格高亮菜单与菜单设置页。
- 内置词典、生词本、中文/英文释义切换、翻译、Web 搜索和智读入口。

### 账号、同步与密钥

- 注册、登录、保存账户、退出登录、账户安全（邮箱绑定/换绑、修改密码、找回密码）及验证码倒计时。
- 同步进度、书签、高亮、批注、评分、标签、书单、生词本和阅读统计；不上传图书文件、正文、封面原图、路径、模型或语义索引。
- 私密配置同步：普通智读/翻译配置可选同步；API Key 仅在 `flutter_secure_storage` 中保存。跨设备传输密钥时使用用户设置的独立同步密码，经 PBKDF2 + AES-256-GCM 端侧加密，服务端只保存密文。
- 支持从云端下载密钥包、服务器的密钥包世代撤销提示，以及本机重新加密上传。

### 其他

- 阅读统计日/月/年/总视图、热力图和柱状图提示。
- 关于页：GitHub Release 为主、公共服务器更新元数据为回退；Android 版本与产品 Release 标签独立比较。
- 当前未纳入：PDF 阅读、双页阅读、iOS 发布、生产签名、把图书文件上传到同步服务器。

上表是“代码存在”的范围，不代表每个交互都已在不同尺寸真机上完成验收。用户目前主要在模拟器逐项验收，真机启动比模拟器快，但冷启动和大书打开仍应量化。

## 3. 关键代码地图

| 主题 | 主要文件 |
| --- | --- |
| 启动、延后维护、全文索引调度 | `lib/main.dart` |
| 书架状态、搜索、同步入口 | `lib/app/app_controller.dart`、`lib/ui/library_shell.dart` |
| 导入与启动缓存 | `lib/app/book_import_service.dart`、`lib/app/shelf_startup_cache.dart` |
| EPUB/TXT、阅读 HTML、缓存与进度 | `lib/reader/epub_parser.dart`、`txt_parser.dart`、`reader_html.dart`、`parsed_book_cache.dart`、`reader_screen.dart` |
| 本地库与全文索引 | `lib/data/app_database.dart`、`library_repository.dart`、`full_text_index_store.dart` |
| 语义检索 | `lib/semantic/semantic_index_service.dart`、`lib/ui/semantic_index_page.dart` |
| 词典/生词本 | `lib/dictionary/`、`lib/vocabulary/` |
| 智读与翻译 | `lib/ai/ai_reader_service.dart`、`ai_reader_sheet.dart`、`lib/ui/ai_translation_sync_page.dart` |
| 高亮菜单与选区 | `lib/reader/highlight_menu.dart`、`reader_screen.dart` |
| 账号 | `lib/auth/auth_service.dart`、`lib/ui/login_sheet.dart`、`account_security_page.dart` |
| 公共同步 | `lib/sync/engine.dart`、`http_sync_api.dart`、`sync_service.dart`、`sqflite_sync_store.dart` |
| 加密密钥包 | `lib/sync/private_sync_service.dart` |
| 自动导入原生桥 | `lib/platform/storage_bridge.dart`、`android/app/src/main/...`、`android/STORAGE_BRIDGE.md` |
| 更新检查 | `lib/update/update_service.dart` |

进入某个问题前先用 `rg` 找真实调用链；不要只改页面文案而绕过 `AppController`、Repository 或同步队列。

## 4. 存储权限与发行 Flavor

| Flavor | 存储能力 | 适用场景 |
| --- | --- | --- |
| `full` | 声明 `MANAGE_EXTERNAL_STORAGE`，用户授权后可递归扫描 Download 与配置的自动导入目录 | 侧载 / 用户明确需要完整文件访问 |
| `play` | 显式移除该权限，仅 SAF 系统文件选择器导入 | Google Play 审核路径 |

Android 11+ 的 SAF 不能可靠授权内部存储根目录或 Download 根目录；不要把 SAF 当成全盘扫描能力。`full` 模式应检查授权是否被撤销，权限缺失时提示用户而不是持续重试。自动扫描是启动/恢复/手动触发加 WorkManager 的尽力任务，不承诺实时监听；WorkManager 周期任务最短约 15 分钟。

原生桥会流式复制到应用私有目录并计算 SHA-256，再原子提交；文件字节不跨 MethodChannel。详细规则在 Android 工程的 `android/STORAGE_BRIDGE.md`。

## 5. 跨端协议与安全边界

`contracts/` 是唯一事实来源，当前 `syncProtocolVersion` 为 1。核心可移植实体包括：

- `book_state_v2`：阅读位置、书签、高亮、批注、评分、标签、书单等轻量状态。
- `vocab`：生词本。
- `reading_bucket_v2`：阅读统计时间桶。
- `model_book_tags_v1`：模型书目标签；与手工标签分离。
- `ai_reader_config_v1`、`translation_config_v1`、可选的 `ai_reader_history_v1`：普通配置/历史。
- `secret_bundle_v1`：仅端侧加密后的密钥包；不得上传明文 API Key 或同步密码。

同步必须处理 `pull → push → inventory → reconcile`、分页、幂等、`updated_at`、`deleted_at`、`sync_version` 和 `device_id`。不可把“本地没有待上传”当作同步成功，也不可因服务器未返回实体就推断删除。图书正文与书文件始终不参与同步。

认证与同步正式地址必须使用 HTTPS。`AppConfig` 仅允许 localhost 或 debug 显式开关使用 HTTP。更新信息的服务器回退目前使用公开 `/updates/*` 元数据；它只用于版本和更新说明，APK 下载仍应走 GitHub Release。

## 6. 构建、测试与产物

环境基线：Flutter 3.44.8、JDK 17、Android SDK 36（以 Android 工程 README 为准）。在 Android 工程根目录运行：

```powershell
flutter pub get
flutter analyze
flutter test

# 侧载测试包：带完整文件访问功能，Profile 仍是测试签名，不可标为正式 Release
flutter build apk --profile --flavor full

# Play 权限边界验证
flutter build apk --debug --flavor play
```

当前观测到的最后一个 full Profile 产物是：

```text
C:\Users\pigki\Documents\Codex\2026-07-21\claude-projects\kunpeng-reader-mobile\build\app\outputs\flutter-apk\app-full-profile.apk
```

它只是测试产物，不能直接作为正式包交付。正式 Release 前必须配置生产 keystore、生成 SHA-256、在真机安装，并清晰标注 `full` 或 `play` flavor。Android 工程当前有 29 个 unit test 文件和 1 个 integration test 文件；本文未重新运行整套 Flutter 测试，接手时应先运行上面的命令。

编译时可覆写服务地址，但发布包不得写入 HTTP：

```powershell
flutter build apk --release --flavor full `
  --dart-define=KUNPENG_API_BASE=https://your-server.example
```

## 7. 当前优先风险与验收清单

按优先级处理，不要为了新增页面跳过这些基础项：

1. **真机性能基线**：冷启动、首次打开大 EPUB、再次打开同书、书架 20/100 本封面加载；记录设备型号、书大小、P50/P95。启动快照、延后维护和章节缓存已经存在，先测量再继续调参。
2. **阅读手势与选区**：验证点击翻页不出现页底残字；滚动跨章不会一甩多页；长按拖动能选择多字；打开智读/设置/返回书架时高亮菜单和系统选区手柄不会残留在错误页面。
3. **密钥包跨端闭环**：在桌面和 Android 使用同一同步密码，完成“原设备加密上传 → 新设备下载 → 直接可用智读/翻译”。如果提示“已撤销”，不要绕过世代保护；需在原设备重新加密同步。不要把密钥或同步密码写入日志/测试。
4. **搜索可靠性**：全文搜索应先进入结果页，再异步建立/读取索引；结果命中高亮、定位到具体章节、按书折叠和“更多 20 条”都要用大书验收。语义索引必须续建而非无故从 0 开始。
5. **自动导入**：验证多个 SAF 目录、权限撤销、重复文件、Download 扫描和 `play` flavor 降级提示；不要把 `MANAGE_EXTERNAL_STORAGE` 误带进 Play 包。
6. **同步一致性**：至少两台设备对同一本书做进度、高亮、批注、书签、词汇、标签/书单和统计操作，再做离线补传与 reconcile；确认不上传书文件。
7. **版本与更新**：保持 Android 版本（如 `0.3.x`）与产品 Release 标签分离。GitHub 缺少 `android_version` 时，客户端应读取服务器最新清单补全可比较的 Android 版本，但下载仍为 GitHub Release。

## 8. 接手工作方式

1. 在 Android 工程执行 `git status --short`、`git log -1 --oneline`、`flutter analyze` 和 `flutter test`，记录真实结果。
2. 先在模拟器复现用户当前问题，再用真机确认；截图不是完成证据。
3. 本端 UI 改动可直接在 Flutter 工程实施。改变同步实体、认证 API、密钥包格式、删除语义或阅读位置语义前，先更新桌面仓库的 ADR、`contracts/`、fixture 和兼容测试。
4. 不覆盖未知未提交修改；不要把 `build/`、密钥、token、真实图书或用户数据提交到 Git。
5. 每轮交付须写明：文件、行为、测试命令与结果、APK 绝对路径/大小/SHA-256、签名状态、尚未验证项。

## 9. 不要做的事

- 不把桌面 SQLite 结构当作 Android 或服务端协议。
- 不上传 EPUB/TXT/PDF、封面原图、正文索引、语义模型、向量或本机路径。
- 不把 API Key、登录密码、同步密码、Token 写入源码、`dart-define` 默认值、测试、截图或日志。
- 不为了让 root/Download 自动扫描“看起来可用”而把宽泛存储权限放进 `play` flavor。
- 不把 Profile/debug 签名 APK 说成正式 Android 发布包。
