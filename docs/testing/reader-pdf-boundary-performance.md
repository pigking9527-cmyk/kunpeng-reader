# 阅读器与 PDF 边界性能基线

## 目的和范围

这套基线覆盖命令式阅读器引擎周围的 TypeScript **协议解析、来源校验和 PDF 生命周期所有权**。样本只使用固定的合成协议 ID、页码、坐标和极小字节数组；不包含真实书籍正文、本机路径、URL、封面或 PDF 文件。

它不是 PDF.js 页面视觉渲染、排版、Canvas、文本层、字体、手势或真实 EPUB/PDF 打开速度的基线。那些项目需要受控的真实样本和目标平台人工验收，不能由此替代。

## 可重复检查

`npm run test:typed` 会收集并执行下列测试：

- `packages/reader-engine/test/performance-baseline.test.mts`
- `packages/reader-engine/test/acceptance-baseline.test.mts`
- `packages/pdf-engine/test/performance-baseline.test.mts`
- `packages/pdf-engine/test/acceptance-baseline.test.mts`

每个协议测试会在同一 Node 进程内处理 10,000 条合成 command/event，并打印耗时和该批次前后的 `heapUsed` 增长。门槛是 5 秒和 64 MiB：它们刻意为慢速或共享 CI 留出余量，用于发现数量级退化或整批消息意外保留，而不是把 V8 的垃圾回收时机当作精确内存测量。

阅读器验收样本以无正文的最小信封覆盖全部公开 shell command 和 frame event，并固定边界拒绝：下限外排版值、负章节、零总章节和越界搜索索引。它用于发现协议新增动作没有进入验收集，或位置/范围校验意外放宽。

PDF 生命周期测试额外连续取消 128 次尚未解析完成的打开请求，并分别取消已经进入 PDF.js loading task 的请求、关闭已经打开的文档、以及在 surface render 尚未返回时关闭文档。`PdfRendererPort.diagnostics` 必须在每轮后显示零活跃 operation、无 loading task、无 document；最终释放后还必须没有 listener。测试也断言 pending task 与 active document 的销毁次数恰为一次。这些确定性的对象所有权上限与宽松堆门槛一起覆盖“取消/cleanup 不泄漏”的边界契约。

## 解读与后续

- 日志中的毫秒数适合和同一 CI 主机或同一开发机的历史结果比较；不同硬件之间不能直接横比。
- 若达到时间或堆上限，应先检查是否在解析器/校验器保存了批量 payload、是否未撤销 listener 或未结束 operation，而不是直接提高阈值。
- 真实 PDF.js 视觉性能、内存峰值和页面恢复仍须以固定的非私密 PDF 样本在 macOS、Windows、Linux 构建产物中单独验收。

## 真实样本验收记录

自动化通过后，发布候选必须按下表对**固定但不提交**的 EPUB 和 PDF 各一份完成一次目标平台验收。样本须为合法可再分发或团队明确获准使用的文件；记录外部样本编号、SHA-256、页数/章节数和许可，不记录标题、正文、本机路径或 URL。除非样本内容确实变更，同一平台的后续结果必须使用同一摘要。

| 项目 | EPUB 样本 | PDF 样本 | 记录方式 |
| --- | --- | --- | --- |
| 功能 | 打开、目录、分页/滚动、单/双页、续读、书内搜索、选区、高亮、批注、字典、朗读、手势与关闭 | 打开、目录、单/双页、缩放、搜索、选区、高亮、批注、续读与关闭 | 每项记通过/失败和截图或录屏的私有存放位置 |
| 性能 | 冷启动后首次可读首屏；预热后翻页、搜索 | 冷启动后首屏；预热后翻页、缩放、搜索 | 每项先预热 3 次、再记录 5 次；保存 P50/P95（ms） |
| 释放 | 连续打开/关闭 20 次后检查进程内存和子窗口 | 连续打开/关闭 20 次后检查进程内存、PDF 子窗口和恢复打开 | 记录第 5 与第 20 次的工作集；不得持续单调增长 |

首轮只建立设备基线，不以跨设备绝对毫秒数判定失败。相同平台、应用版本线和样本摘要的后续候选，如 P95 相比已批准基线变慢超过 `max(20%, 150 ms)`，或第 5 至第 20 次关闭循环的工作集持续增长超过 100 MiB，应阻止删除旧入口并调查原因。崩溃、无法恢复位置、错误文档仍可操作、未关闭子窗口或任何功能项失败均为立即失败。

### 私有记录工具

仓库不保存真实 EPUB/PDF、其路径、标题、正文、URL、截图或录像。准备好已获准的样本后，用下列工具在**仓库外**创建验收记录；工具流式计算 SHA-256，且只写入命令显式提供的匿名样本编号、许可/来源引用、计时和内存数值。它会拒绝向本仓库写入记录。

验收人可另外传入仓库外受控截图或录屏。记录只保存验收人指定的非路径证据编号、媒体类型和 SHA-256；不保存媒体路径、文件名、缩略图、时长或任何画面内容。每个必测场景必须使用独立媒体摘要，不能以同一截图或录屏重复覆盖多个场景。EPUB 必须保留首屏、翻页和搜索；PDF 必须保留首屏、翻页、搜索及缩放/旋转后渲染四类能由私有证据编号关联的视觉证据。性能度量固定为 EPUB 的 `firstReadableMs`、`turnPageMs`、`searchMs`，以及 PDF 的 `firstReadableMs`、`turnPageMs`、`searchMs`、`pdfRenderMs`、`zoomMs`；截图或录屏实际保管、访问控制和保留期由团队受控证据库负责。

```sh
node scripts/record-reader-sample.mjs \
  --format epub --file /controlled-samples/reader.epub \
  --sample-id LEGAL-SAMPLE-001 --license CC-BY-4.0 \
  --source-id approved-source-reference --units 12 \
  --app-build 1.0.0 --platform macos-arm64 --device-id bench-device-01 --condition cold-start \
  --warmup firstReadableMs=120,115,118 \
  --timing firstReadableMs=109,112,110,108,111 \
  --warmup turnPageMs=42,41,43 \
  --timing turnPageMs=40,41,42,43,44 \
  --warmup searchMs=62,61,63 \
  --timing searchMs=60,61,62,63,64 \
  --screenshot EPUB-FIRST-PAGE=/controlled-evidence/epub-first-page.png \
  --recording EPUB-PAGE-TURN=/controlled-evidence/epub-page-turn.mov \
  --screenshot EPUB-SEARCH=/controlled-evidence/epub-search.png \
  --memory-cycle-5-mib 420 --memory-cycle-20-mib 435 \
  --output /controlled-records/epub-LEGAL-SAMPLE-001.json
```

每个性能项目提供恰好 3 个预热值和 5 个记录值；工具会写出 P50/P95。EPUB 必须记录 `firstReadableMs`、`turnPageMs`、`searchMs` 及 `EPUB-FIRST-PAGE`、`EPUB-PAGE-TURN`、`EPUB-SEARCH` 三个匿名视觉证据；PDF 还必须记录 `pdfRenderMs`、`zoomMs` 及 `PDF-FIRST-PAGE`、`PDF-PAGE-TURN`、`PDF-SEARCH`、`PDF-RENDER-ZOOM` 四个证据。`--condition` 标记本次冷启动或预热态；`--units` 对 EPUB 表示章节数、对 PDF 表示页数。关闭循环的第 5/20 次工作集须成对提供，工具会标注是否低于 100 MiB 增长门槛。可重复 `--screenshot` 或 `--recording`，格式是 `匿名证据编号=/绝对/受控媒体路径`；工具拒绝仓库内媒体文件，且要求不同必测场景的媒体摘要不同，JSON 只写入编号、类型和摘要。生成后请执行 `node scripts/validate-reader-sample-record.mjs /仓库外/record.json`；校验器只接受 schema v3 的精确字段形状、必填计时/证据和由原始数据计算出的 P50/P95、内存增长，不允许路径、标题、正文、URL 或其他未知字段。生成记录的字段形状见 [`reader-pdf-sample-record.template.json`](reader-pdf-sample-record.template.json)；模板只含示例数据，不能视为验收结果。

### macOS 人工验收表

复制 [`macos-reader-pdf-acceptance.template.md`](macos-reader-pdf-acceptance.template.md) 到
仓库外的受控位置，按表完成 EPUB 和 PDF 的功能、性能、关闭释放与删除旧组件门槛。
表内只允许匿名样本 ID、摘要、许可引用、数值和私有证据编号；不得填写或链接真实
样本、文件名/路径、标题、正文、URL、截图、录屏或应用数据。该表保持空白，不能被
当作任何一次验收已通过的凭证。
