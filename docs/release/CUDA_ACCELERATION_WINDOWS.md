# Windows CUDA 加速组件（v1.13.0）

`Kunpeng-Reader-v1.13.0-Windows-CUDA-provider.zip` 是可选组件，仅适用于
Windows x64、受支持的 NVIDIA GPU 和驱动版本不低于 527.41 的设备。

压缩包内的 `onnxruntime_providers_cuda.dll` 与
`onnxruntime_providers_shared.dll` 必须和阅读器安装目录中的
`onnxruntime.dll` 保持同一版本，不能和其他 ONNX Runtime 版本混用。

该组件不包含 NVIDIA 驱动、CUDA Toolkit 或 cuDNN；这些第三方运行环境应由
用户从 NVIDIA 官方渠道安装和更新。没有可用 GPU、驱动过旧或缺少 CUDA
依赖时，阅读器仍保持 CPU 模式运行。

这是运行时组件下载，后续版本会在应用内完成安装与启用流程；请勿覆盖阅读器
的主程序或 `onnxruntime.dll`。
