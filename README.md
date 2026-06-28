# 鲲鹏阅读器（Kunpeng Reader）

一个面向 Windows 的高性能本地电子书阅读器。Rust + Tauri 2 + 系统 WebView2，书架与阅读页相互独立、EPUB 原生渲染、按章虚拟化加载，大书秒开。

## 特性
- **多格式**：EPUB / PDF / TXT / Markdown，批量导入、封面墙、拖拽导入
- **独立窗口**：书架窗口与每个阅读窗口彼此独立，记忆大小/位置
- **流畅阅读**：CSS 多栏按章虚拟化分页；目录虚拟章节、书内搜索、书签、主题、翻页留余量
- **书架全文检索**：缓存逐章纯文本索引 + 多线程 + 字节级 `memmem` 匹配
- **语义检索**：`bge-small-zh-v1.5`（fastembed/ONNX，离线）向量嵌入；逐本向量 + 全库 HNSW 近邻索引（instant-distance），按"意思相近"检索
- **划词 web 搜索**、阅读统计、阅读时长等

详见 [开发文档.md](开发文档.md)。

## 构建
```powershell
cd ebook-reader-tauri   # 或仓库根目录
cargo build --release
# 产物：target/release/ebook-reader-tauri.exe
```

首次使用语义检索会自动下载约 120MB 的中文语义模型（之后离线运行）。
