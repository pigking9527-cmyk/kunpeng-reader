# 鲲鹏阅读器 v1.13.0

发布日期：2026-08-07

## 重点更新

- 语义检索新增 BGE-M3、Multilingual-E5-Small、全文与语义融合、可选重排、BGE-M3 长文精读和非阻塞状态读取。
- 设置、书库问答、资讯、统计、排序过滤、账户与阅读页菜单完成十种语言覆盖；朗读会自动匹配文本语言。
- Bug 反馈可带上最近两分钟的脱敏问题记录，也可单独保存 JSON 到桌面。
- 资讯来源管理独立成页，并加入可绘制、可调精度的右键手势返回；书架封面首屏加载可按固定数量或上次可见数量选择。
- Windows 安装包会同时安装语义检索运行时，开箱即可启动。
- 另附 Windows x64 可选 CUDA Provider 组件，便于支持 NVIDIA GPU 的设备预先下载；不包含 NVIDIA 驱动、CUDA Toolkit 或 cuDNN。

## 桌面发布包

- Windows x64：便携版、NSIS 安装包、`SHA256SUMS.txt`
- macOS Apple Silicon：DMG、App ZIP、`SHA256SUMS-macOS.txt`
- Linux x86_64：AppImage、deb、`SHA256SUMS-Linux.txt`

Windows 当前未作 Authenticode 签名；macOS 当前使用临时签名，未进行 Developer ID 公证；Linux 基线为 Ubuntu 24.04 / glibc 2.38+。
