# Kunpeng Reader

[中文](README.md) | **English**

A high-performance local ebook reader for Windows, macOS, and Linux. The desktop app is built with **Rust + Tauri 2 + the system WebView**. Its shelf and reading window are independent; EPUB content is rendered natively and loaded on demand by chapter or virtual subchapter for faster opening of large books.

> **License notice:** this repository is **source-available**. The code is public only for learning, evaluation, and communication. Copying, modifying, distributing, commercial use, or publishing derivative versions requires the author's written permission. See [LICENSE](LICENSE).
> See [licensing scope](docs/legal/licensing-scope.md) and [third-party notices](THIRD_PARTY_NOTICES.md) for first-party and bundled-material boundaries. Historical GPL remediation, asset disposition, and review are complete; every public test package must still pass the distribution license and IP checks.

> The current desktop candidate is **Beta 1.1 revision** (technical version `1.1.0-beta.2`). Repository: [github.com/pigking9527-cmyk/kunpeng-reader](https://github.com/pigking9527-cmyk/kunpeng-reader). Public binaries remain subject to license, IP, signing, and notarization gates.

See the [Beta 1.1 revision notes](docs/release/1.1.0-beta.2.md) and the [desktop artifact verification requirements](docs/release/desktop-artifact-verification.md) for the candidate scope, retirement of the broken packages, and release checks.

## Features

### Reading

- **Formats:** EPUB, PDF, TXT, Markdown, MOBI, AZW and AZW3; batch import, cover wall, drag-and-drop import, cover replacement, and multi-folder automatic import.
- **Ratings, tags and collections:** half-star ratings, filtering and cover badges; manage tags and collections from the book context menu, with collection descriptions, covers, ordering and multi-select filtering.
- **EPUB:** CSS multi-column pagination by chapter/virtual subchapter, virtualised large chapters, table of contents, single/double-page and scrolling modes, click-to-turn pages, bookmarks, full-book search, inline footnotes, themes, configurable typography and margins, and optional offline fonts.
- **PDF:** PDF.js rendering with continuous scrolling, a text selection layer, outline, fit/precise zoom, double-page mode, search, highlights and annotations.
- **TXT:** automatic chapter detection for web novels and virtual loading for million-word files.
- **Highlights and annotations:** selection menus can be arranged as a row or grid, use four colors, choose Baidu/Google web search, remain usable across multi-line/page selections, and open a unified annotation manager.
- **AI Reader (BYOK):** ask questions, summarise read content, or generate visual mind maps from the selection menu. Supports DeepSeek, OpenAI, Anthropic and OpenAI-compatible endpoints, with local history.
- **Immersive mode and TTS:** hide/reveal the toolbar without a layout jump; system/offline or Microsoft neural (edge-tts) voices with word highlighting and automatic page turns.
- **Dictionary and vocabulary:** offline Chinese/English dictionaries, imported TSV/CSV/JSON/StarDict/common unencrypted MDX dictionaries, source priority, automatic vocabulary collection, sorting, lookup counts and optional high-frequency-word speech packs.
- **Library search and translation:** search selected text across the complete shelf, grouped by book with expandable results and source navigation; translate selected passages using user-configured DeepL, Google, Baidu or Tencent credentials.

### Library Q&A (RAG / BYOK)

- Ask questions over the complete shelf or narrow scope by tags, collections, manually selected books, or cross-book comparison.
- Deep one-book Q&A combines the table of contents, opening content and retrieved passages.
- Markdown answers with inspectable citations, source previews and a jump back to the original location.
- Separate model-generated classification tags, local-first history with optional privacy-preserving history sync, multiple provider profiles, and list/grid Q&A history views with answer summaries.

### News (Windows)

- A local news stream with categories, up to 24 managed sources, list/grid and mixed/by-source layouts.
- Reader-style extracted articles that remove navigation, advertising, comments and login overlays while retaining title, content, images, source and time.
- Optional background prefetch, five-minute refresh while idle, six concurrent fetches, local-cache-first opening and lazy cover loading.

### Search, data and reliability

- Shelf full-text search uses compressed chapter text, Bloom prefiltering, bounded LRU cache, threaded byte-level `memmem`, and exact-scan fallback.
- Offline semantic search uses `bge-small-zh-v1.5` / ONNX with multi-centroid profiles and sharded HNSW indexes, including safe migration of legacy data.
- Redesigned day/month/year/all-time reading statistics with a contribution heatmap and SVG charts; retain display preferences and switch time/words, bar/line charts, and heatmap color. SQLite light-data storage uses WAL management, daily restore points, verified restore/data-package imports, and a single-instance runtime.
- Account sync covers light data such as progress, highlights, annotations, vocabulary, statistics and settings. Book files, semantic models, indexes, local paths and plaintext API keys are not synced.
- Settings can clear local data, clear local and cloud data, or permanently delete an account. None of these actions delete user-imported original book files.
- Release workflow includes GitHub Actions, shared local checks, Windows portable/NSIS builds, macOS Apple Silicon DMG/App ZIP, Linux AppImage/deb and SHA-256 manifests.

> AI features use your own API key. Credentials are protected with system capabilities and stored locally; they are not sync entities. Only already-read relevant passages and explicitly selected text are sent to an AI provider.

For implementation details, see [开发文档.md](开发文档.md) (Chinese). Version history is in [开发记录.md](开发记录.md) (Chinese).

## Build

### Windows

Routine checks:

```powershell
cd ebook-reader-tauri
powershell -ExecutionPolicy Bypass -File scripts/check.ps1
```

GitHub Actions runs the same checks on pushes and pull requests to `main`.

Repository safety rules and the explicit release staging workflow are documented in [Repository safety](docs/security/repository-safety.md). Install the commit hook after cloning and never use stage-all for releases.

Release build (produces the release executable, updates the project-root runtime, validates the icon and refreshes the Windows icon cache):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1
```

Full release (checks, portable binary, NSIS installer, tag, GitHub Release and assets):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/release.ps1
```

```powershell
cargo tauri build
# Installer output: target/release/bundle/nsis/
```

- Portable executable: `target/release/ebook-reader-tauri.exe`; the local runtime is `鲲鹏阅读器.exe` plus `onnxruntime.dll` in the project root.
- Installer: `target/release/bundle/nsis/`.

### Linux x86_64

The `Linux x86_64 build` workflow uses Ubuntu 24.04 and produces:

- `Kunpeng-Reader-v<version>-Linux-x86_64.AppImage`
- `Kunpeng-Reader-v<version>-Linux-x86_64.deb`
- `SHA256SUMS-Linux.txt`

```bash
chmod +x Kunpeng-Reader-v*-Linux-x86_64.AppImage
./Kunpeng-Reader-v*-Linux-x86_64.AppImage
sudo apt install ./Kunpeng-Reader-v*-Linux-x86_64.deb
```

The current semantic-search runtime requires glibc 2.38 or later, so Ubuntu 24.04 x86_64 is the initial Linux compatibility baseline. Packages have link and virtual-display startup smoke checks, but are not yet signed; Ubuntu 22.04, Debian 12 and other distributions still require separate acceptance testing.

## Technology

Rust · Tauri 2 · WebView2 / WKWebView / WebKitGTK · custom URI protocol for chapter/resource virtualisation · fastembed (ONNX) · instant-distance (HNSW) · PDF.js · tokio-tungstenite (edge-tts).
