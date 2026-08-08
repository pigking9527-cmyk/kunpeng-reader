# Windows / Linux CUDA 加速发布规则

Windows x64 与 Linux x86_64 的正式包继续保留 CPU 回退路径。检测、下载或加载 GPU
组件失败时，阅读器必须能正常启动并使用 CPU，不能让没有 NVIDIA 显卡的用户受影响。

## Windows 固定版本

Windows 使用同一个官方 `onnxruntime-gpu 1.24.2` wheel 中的三件套，禁止混用不同
构建日期或版本：

- `onnxruntime.dll`
- `onnxruntime_providers_cuda.dll`
- `onnxruntime_providers_shared.dll`

`scripts/prepare-windows-gpu-runtime.ps1` 从 PyPI 官方文件地址下载固定 wheel，并校验
wheel 和解压文件的 SHA-256。Fast/release 构建脚本都必须在交付前调用它。历史资产
`Kunpeng-Reader-v1.13.0-Windows-CUDA-provider.zip` 只用于追溯，不得与当前主库混用。

## 小依赖随包，大依赖按需安装

Windows 安装包额外自带两个不足 1 MiB 的入口库及 NVIDIA 许可证：

- `cudart64_12.dll`
- `cudnn64_9.dll`

cuBLAS、cuFFT、nvJitLink 和其余 cuDNN 运行库解压后超过 2 GiB，不进入普通安装包。
设置页检测到缺失时显示“安装 GPU 组件”，从公开 GitHub Release
`cuda-runtime-windows-v1` 下载两个固定资产（合计 1,494,396,282 字节）：

- `Kunpeng-Reader-CUDA-12.8-core-Windows-x64.zip`
- `Kunpeng-Reader-cuDNN-9.10.2-Windows-x64.zip`

下载过程显示进度。每个压缩包先校验固定 SHA-256，解压后再逐个校验 DLL 的大小与
SHA-256，全部通过后才原子替换用户数据目录中的运行库。大文件使用 HTTP Range 断点
续传；读取超时或连接提前结束时自动重试五次，并保留 `.download` 文件供下次点击继续，
不会重复下载已有字节。失败时只删除临时安装目录并保留 CPU 回退。运行库目录加入当前
进程 DLL 搜索路径后，再做一次真实 CUDA Provider
注册测试；不能仅以“文件存在”宣称 GPU 已就绪。

设置页打开时自动读取上次保留的下载字节并显示百分比；GPU、驱动和 Provider 注册检测
使用 Tauri 阻塞任务线程执行，不得占用 WebView 页面线程。Windows 调用 `nvidia-smi`
必须带 `CREATE_NO_WINDOW`，不能闪出控制台；GPU 状态文字区与按钮列预留固定布局空间，
检测中文案替换前后不得改变设置页长度。

## Linux

Linux AppImage 与 deb 继续随包携带：

- `libonnxruntime_providers_cuda.so`
- `libonnxruntime_providers_shared.so`

Linux 当前使用系统 CUDA 12/cuDNN 9 运行依赖；界面应报告具体缺失库并回退 CPU。
后续若增加 Linux 按需组件，必须使用独立的 Linux 资产、哈希和缓存目录，不能复用
Windows DLL 资产。

## 发布检查

- Windows 主库与两个 Provider 必须来自同一个官方 wheel。
- 普通安装包必须包含两个小型 NVIDIA DLL 和三份许可证。
- GitHub 大组件资产的文件名、字节数和 SHA-256 必须与 `gpu_runtime.rs` 完全一致。
- GPU 就绪状态必须来自真实 Provider 注册；任何失败都只能回退 CPU，不能阻止启动。
