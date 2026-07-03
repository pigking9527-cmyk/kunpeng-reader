# 鲲鹏阅读器（Kunpeng Reader）

一个面向 Windows 的高性能本地电子书阅读器。**Rust + Tauri 2 + 系统 WebView2**，书架与阅读页相互独立、EPUB 原生渲染、按章虚拟化加载，大书秒开。
> **许可说明**：本仓库为 **source-available**，代码公开仅供学习、评估和交流；未经作者书面许可，不得复制、修改、分发、商用或发布衍生版本。详见 [LICENSE](LICENSE)。

> 最新版本：**v1.8.3** · 下载见 [Releases](https://github.com/pigking9527-cmyk/kunpeng-reader/releases)（Windows 安装包 / 单文件绿色版，Win10/11 自带 WebView2）。

## 特性

**阅读**
- **多格式**：EPUB / PDF / TXT / Markdown / MOBI / AZW / AZW3，批量导入、封面墙、拖拽导入、更换封面、**多目录自动导入**
- **评分**：书籍信息里五星打分（**支持半星**），书架可**按评分过滤**，评分小星可叠在封面上
- **EPUB**：CSS 多栏按章虚拟化分页、目录/虚拟章节、书签、书内搜索、脚注就地弹窗、主题（浅/深/护眼）、字体/字号/行距/边距随心调
- **PDF（PDF.js 自渲染）**：连续滚动、文字层选择、内置目录、缩放（适配窗口 + 细粒度）、**双页模式**、PDF 内搜索、PDF 高亮/批注、记住缩放/双页
- **TXT**：网文按「第X章」自动切章建目录，百万字大文件虚拟化加载、秒开
- **高亮 / 批注**：选中即高亮或批注，大批注页统一管理（含上下文、可编辑跳转）
- **沉浸模式**：隐藏工具栏、点屏幕中间唤出，切换零重排不跳页
- **朗读（TTS）**：逐词高亮 + 自动翻页；系统语音（离线）或在线·微软神经（edge-tts，免费 Azure 级中文音色）
- **词典 / 生词本**：划词或高亮文字可离线查词，支持**中中 / 中英 / 英中 / 英英**；查过的词自动进入生词本，可按查询时间或次数排序，并可隐藏/显示查询次数

**检索**
- **书架全文检索**：逐章纯文本缓存 + 多线程 + 字节级 `memmem`，全库秒搜
- **语义检索**：`bge-small-zh-v1.5`（fastembed / ONNX，离线）向量嵌入；分片 HNSW 近邻索引（instant-distance）+ 按内存自适应，按「意思相近」检索全库；索引会检查源文件变化并提示单本构建失败

**统计与其它**
- **详细阅读统计**：日 / 月 / 年 / 总四视图，时长、字数、读过/读完、高亮/批注，阅读贡献图与 SVG 图表
- **账号与同步**：支持注册 / 登录，将阅读进度、高亮、批注、生词本、阅读统计、设置等轻数据同步到服务器；账号窗口可保存多个本机账号信息
- **本地 SQLite 数据层**：书籍、阅读进度、高亮、批注、生词本、设置、阅读统计等统一写入本地 SQLite，并为后续多端同步预留 `updated_at / deleted_at / device_id / sync_version`
- **数据包导入 / 导出**：可导出轻数据包，用于备份或迁移
- **高频词语音包**：可在本机生成前 10,000 高频英文词语音缓存，支持暂停、继续、进度显示和删除
- **「我的书架」显示设置**：封面是否显示阅读进度 / 评分 / 书名，各自开关；网格视图可只显示封面
- **新版提示**：启动后台优先检查 GitHub 最新发行版，连接失败时走服务器更新清单兜底；「关于」里可手动检查更新、看本版更新内容
- **稳定发布流程**：固定检查脚本、UTF-8 检查、release 构建脚本，自动校验图标并刷新 Windows 图标缓存
- 划词 web 搜索、独立窗口（EPUB 与 PDF 各自记忆几何）、关于页

更多细节见 [开发文档.md](开发文档.md)；版本变更见 [开发记录.md](开发记录.md)。

## 构建

### Windows

日常检查：

```powershell
cd ebook-reader-tauri
powershell -ExecutionPolicy Bypass -File scripts/check.ps1
```

发布构建（生成 release exe、复制单个可执行文件到桌面、校验图标并刷新 Windows 图标缓存）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1
```

安装包：

```powershell
cargo tauri build
# 安装包输出：target/release/bundle/nsis/
```

- 单文件绿色版：`target/release/ebook-reader-tauri.exe` 或桌面 `鲲鹏阅读器.exe`
- 安装包：`target/release/bundle/nsis/`
- v1.8.3 继续使用 ThinLTO + 多 codegen units + 增量编译，保留 `opt-level=3` 的同时加快日常迭代；同时加强模块边界、HTTPS/URL 打开安全和真实容器烟测。
- 首次使用**语义检索**会自动下载约 120MB 的中文语义模型（之后离线运行）。
- **在线朗读**（edge-tts）需联网；离线可在「设置 → 朗读」切到系统语音。

## 技术栈

Rust · Tauri 2 · WebView2 · 自定义 URI 协议（按章/资源虚拟化）· fastembed(ONNX) · instant-distance(HNSW) · PDF.js · tokio-tungstenite(edge-tts)
