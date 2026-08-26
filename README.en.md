# Kunpeng Reader

[中文](README.md) | **English**

[**View three-platform test build status (Windows / macOS / Linux)**](https://github.com/pigking9527-cmyk/kunpeng-reader/actions)

A high-performance local ebook reader for Windows, macOS, and Linux. The desktop app uses **Rust + Tauri 2 + the system WebView**. The shelf and reading window are independent, EPUB content is rendered natively, and chapters or virtual subchapters are loaded on demand so large books open faster.
> **License notice:** this repository is **source-available**. The code is public only for learning, evaluation, and communication. Copying, modifying, distributing, using it commercially, or publishing derivative versions requires the author's written permission. See [LICENSE](LICENSE).
> See [licensing scope](docs/legal/licensing-scope.md) and [third-party notices](THIRD_PARTY_NOTICES.md) for the boundaries of first-party code and third-party materials. Because historical GPL dependency remediation is still in progress, new public binary releases are currently paused by the license gate; local and CI acceptance builds are unaffected.

> The current desktop version is **Beta 1.1** (technical version `1.1.0-beta.1`). Repository: [github.com/pigking9527-cmyk/kunpeng-reader](https://github.com/pigking9527-cmyk/kunpeng-reader). Public binary releases must still pass license, intellectual-property, and platform-signing gates.

## Features

**Reading**
- **Multiple formats:** EPUB / PDF / TXT / Markdown / MOBI / AZW / AZW3, with batch import, a cover wall, drag-and-drop import, cover replacement, and **multi-folder automatic import**
- **Ratings:** assign five-star ratings in half-star increments, filter the shelf by rating, and optionally show rating stars on book covers
- **Tags and collections:** add, remove, and manage tags or collections from a book's context menu; collections support descriptions, covers, drag sorting, and multi-select filtering, and this lightweight classification data can sync with the book
- **EPUB:** CSS multi-column pagination by chapter or virtual subchapter, fast pagination and batched layout for very large chapters, table of contents and virtual chapters, full-page single/double-page views, continuous scrolling with click-to-turn virtual pages, bookmarks, in-book search, inline footnote popovers, light/dark/eye-care themes, and configurable font, size, line spacing, and margins; LXGW WenKai Lite, Source Han Serif, and Zhuque Fangsong can be downloaded on demand and used offline
- **Page-turning experience:** full-page mode supports single- and double-page display; scrolling mode remains genuinely continuous while mouse and keyboard controls can move by virtual page segments; the full-page animation moves the old and new pages left together and avoids flashing when crossing chapter boundaries
- **PDF (self-rendered with PDF.js):** continuous scrolling, selectable text layer, built-in outline, fit-to-window and fine-grained zoom, **double-page mode**, in-PDF search, PDF highlights and annotations, and remembered zoom/double-page settings
- **TXT:** automatically detects “Chapter X” headings in web novels, builds a table of contents, and virtualises million-word files for near-instant opening
- **Highlights / annotations:** highlight or annotate selected text; the highlight menu supports row or 3×3-grid layouts, four colors, and Baidu/Google web search; multi-line and cross-page selections keep the menu in a usable position, and a dedicated page manages large annotation sets
- **AI Reader (BYOK):** open the right-side reading assistant from the selection menu to ask about already-read content, summarise it, or generate a visual mind map, with local Q&A history; supports DeepSeek, OpenAI, Anthropic, and OpenAI-compatible endpoints
- **Immersive mode:** hide the toolbar and reveal it by clicking the center of the page, without relayout or page jumps
- **Read aloud (TTS):** word-by-word highlighting and automatic page turns using offline system voices or online Microsoft neural voices through edge-tts
- **Dictionary / vocabulary:** look up selected or highlighted text offline with built-in Chinese Wiktionary, CC-CEDICT, and ECDICT data; switch among Chinese-Chinese, Chinese-English, English-Chinese, and English-English definitions; import TSV / CSV / JSON, StarDict, and common unencrypted MDX dictionaries; external dictionaries take priority over built-in ones, and looked-up words are added to the vocabulary list with time/count sorting and optional count display
- **Cross-book search:** search selected words or sentences across the whole shelf, including the current book, group results by book, collapse or expand them in batches, and jump back to the source location
- **Selection translation:** translate long selected passages from the reading-page menu using user-configured DeepL / Google / Baidu / Tencent credentials

**Library Q&A (RAG / BYOK)**

- **Whole-library or single-book Q&A:** search the entire shelf, tags, collections, a manually selected scope, or a specified book, with both cross-book comparison and deep single-book answers
- **Citations and classification:** answers include footnote sources that can be previewed and opened at the original book location; model-generated classification tags can help scope searches and rank results
- **Models, history, and privacy:** supports DeepSeek, OpenAI, Claude, and compatible endpoints; history stays local by default, and only privacy-filtered Q&A is synced when the user enables it—book content, original files, paths, semantic indexes, and plaintext API keys are never uploaded

**News (Windows)**

- **News stream and articles:** browse a row or grid news stream by category and source; articles open inside the reader with cleaned title, content, images, source, and publication time
- **Cache and prefetch:** opening prefers the local cache, optional background prefetch is available, and cover images load lazily as their cards enter the viewport

**Intelligence Center (Windows, experimental)**

- **Integrated briefings:** collect news from the public source directory in batches, then deduplicate it locally, merge reports about the same event, rank them, and extract topic highlights; after the full local corpus is built, sources rotate through incremental updates
- **Traceable evidence:** briefing items, related signals, and candidates open directly in the cleaned article reader while retaining links to the original sources; snapshots remain local, are not uploaded to the library, and do not call external models
- **Multiple research views:** includes briefing, monitoring, research, and interstellar-travel views; the interstellar view only filters relevant candidate signals and displays a human-defined baseline—it never counts news automatically as progress

**Search**
- **Shelf full-text search:** compressed per-chapter text indexes, Bloom prefiltering, a bounded LRU cache, and multithreaded byte-level `memmem`, with exact-scan fallback for both speed and complete results
- **Semantic search:** offline `bge-small-zh-v1.5` embeddings through fastembed / ONNX, combined multi-centroid profiles, and sharded HNSW nearest-neighbor indexes; legacy semantic profiles and HNSW data are migrated automatically, and the main settings page manages the model and semantic/accelerated indexes

**Statistics and more**
- **Mouse gestures (desktop):** enable and manage them under Common Settings → Gestures; record with the left button and execute by dragging the right button, with configurable back/close, information/explanation, and reopen-previous-page actions
- **Gesture recognition and precision:** matches normalized shape and direction order without requiring identical total distance or segment proportions; supports global or per-gesture precision levels from 1 to 10 and custom hint styles
- **Detailed reading statistics:** day / month / year / all-time views for duration, word count, books read/finished, highlights, and annotations, plus a contribution heatmap and SVG charts; switch between time/words, bar/line charts, and heatmap palettes, with display preferences retained
- **Account and sync:** register or sign in to sync lightweight data such as progress, highlights, annotations, vocabulary, reading statistics, and settings; cursors, statistics, and confirmation baselines are isolated by normalized server address plus account, so changing accounts never reuses another account's sync state; account state is restored and automatically synced at startup, with a bounded sync before exit
- **Data and privacy:** separately clear this device, clear this device plus cloud data, or permanently delete the account; cloud clearing advances the data generation and revokes old tokens so offline devices cannot restore deleted data; none of these actions deletes original book files imported by the user
- **Local SQLite data layer:** lightweight data is stored in SQLite with WAL automatic checkpointing, log-size management, and a portable v2 entity model; legacy databases are migrated through a safe compaction process
- **Restore points and data packages:** create a daily restore point automatically and keep up to seven, with manual backup support; restore transaction v2 uses file sizes and SHA-256 manifests, verifies integrity by opening only existing databases, and provides crash-idempotent rollback; data-package import creates an automatic backup before applying data immediately
- **Runtime reliability:** Windows uses a system mutex and macOS / Linux use file locks for single-instance operation and forwarding books to open; backup and restore enter a global data-maintenance critical section; resumable background tasks advance only after durable checkpoints succeed, and semantic indexing saves progress at whole-book boundaries
- **Page-count cache:** total pages are calculated incrementally per chapter for the current layout and reused; the AI Reader sidebar only compresses text temporarily and does not clear or recalculate this cache, while double-page mode still reports the physical single-page total
- **High-frequency-word voice pack:** generate a local speech cache for the 10,000 most frequent English words, with pause, resume, progress, and deletion controls
- **“My Shelf” display settings:** independently show or hide reading progress, rating, and title on covers; grid view can display covers only, and the filter panel can use automatic column sizing or a fixed number of cover columns
- **Update notifications:** startup checks GitHub releases in the background first and falls back to the server update manifest if GitHub is unavailable; About supports manual update checks and displays the current release notes
- **Stable release workflow:** GitHub Actions and the fixed local `scripts/check.ps1` share tests, UTF-8, version consistency, icon, security-baseline, and CSS checks; release scripts validate icons and refresh the Windows icon cache; GitHub Releases publish a Windows single-file portable build and installer, macOS Apple Silicon DMG/App ZIP, Linux AppImage/deb, and platform-specific SHA-256 manifests
- Selection-based web search, independent windows whose geometry is remembered separately for EPUB and PDF, and an About page

> AI Reader uses your own API key. Credentials are protected by system capabilities and stored only on this device; they are not sync entities. Only relevant chapters that have already been read and text explicitly selected by the user are sent to the provider.

For more details, see [开发文档.md](开发文档.md) (Chinese). Version changes are recorded in [开发记录.md](开发记录.md) (Chinese).

## Build

### Windows

Routine checks:

```powershell
cd ebook-reader-tauri
powershell -ExecutionPolicy Bypass -File scripts/check.ps1
```

GitHub Actions runs the same checks on pushes and pull requests to `main`.

See [Repository safety](docs/security/repository-safety.md) for the data-safety process before commits and releases. Install the commit hook after the first clone; releases must stage an explicit file list with `scripts/stage-release.ps1`, never “stage all.”

Release build (generates the release executable, updates the project-root runtime file, creates the desktop shortcut, validates the icon, and refreshes the Windows icon cache):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1
```

Full release (checks, portable build, NSIS installer, tag, GitHub Release, and asset upload):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/release.ps1
```

Installer build:

```powershell
cargo tauri build
# Installer output: target/release/bundle/nsis/
```

- Single-file portable build: `target/release/ebook-reader-tauri.exe`; ONNX Runtime is statically linked, the local runtime file is `鲲鹏阅读器.exe` in the project root, and the desktop contains only the `鲲鹏阅读器.lnk` shortcut
- Installer: `target/release/bundle/nsis/`

### Linux x86_64

The `Linux x86_64 build` GitHub Actions workflow uses Ubuntu 24.04 to build and verify:

- `Kunpeng-Reader-v<version>-Linux-x86_64.AppImage`
- `Kunpeng-Reader-v<version>-Linux-x86_64.deb`
- `SHA256SUMS-Linux.txt`

After downloading the AppImage, make it executable:

```bash
chmod +x Kunpeng-Reader-v*-Linux-x86_64.AppImage
./Kunpeng-Reader-v*-Linux-x86_64.AppImage
```

Ubuntu / Debian users can also install the deb package:

```bash
sudo apt install ./Kunpeng-Reader-v*-Linux-x86_64.deb
```

The current semantic-search runtime requires glibc 2.38 or later, so Ubuntu 24.04 x86_64 is the initial Linux compatibility baseline. Linux artifacts have passed link checks and startup smoke tests under a virtual display, but are not yet signed; Ubuntu 22.04, Debian 12, and other distributions still require separate acceptance testing.

## Technology

Rust · Tauri 2 · WebView2 / WKWebView / WebKitGTK · custom URI protocol for chapter/resource virtualisation · fastembed (ONNX) · instant-distance (HNSW) · PDF.js · tokio-tungsten (edge-tts).
