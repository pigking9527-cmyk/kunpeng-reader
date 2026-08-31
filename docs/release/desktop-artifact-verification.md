# 桌面安装包验证要求

## 目的

发布工作流必须验证“构建成功”之外的安装包内容，避免把开发辅助进程、空壳或错误目标作为桌面应用上传。

## 不变条件

- Cargo 和 Tauri 的桌面主程序均为 `ebook-reader-tauri`。
- Windows 便携版来自 `target/release/ebook-reader-tauri.exe`。
- macOS App、ZIP 和 DMG 的 `CFBundleExecutable` 均为 `ebook-reader-tauri`，且该文件可执行。
- Linux AppImage 与 deb 均包含 `/usr/bin/ebook-reader-tauri`。
- 许可证清单、校验和与既有签名/公证检查仍是独立且必须通过的门禁。

## 工作流检查

Windows、macOS 与 Linux 构建命令均向 Tauri/Cargo 显式传入主二进制。macOS 会在生成 ZIP 和 DMG 后分别检查其内容；Linux 会检查 deb 和解包后的 AppImage。任一条件不满足，工作流必须在上传构建产物和发布资产前失败。

## 发行前人工核对

1. 确认候选版本、标签、`Cargo.toml` 与 `tauri.conf.json` 一致；
2. 查看三个工作流的安装包验证步骤均成功；
3. 在干净环境安装每个平台的包并启动阅读器窗口；
4. 校验对应 SHA-256 清单；
5. 只有许可证、产权、签名和公证门禁也全部通过时，才允许上传公共资产。
