# Windows / Linux CUDA 加速发布暂停

产权整改期间，Windows x64 与 Linux x86_64 发行包只承诺 CPU 回退路径。仓库不得自动
下载、打包或发布 NVIDIA CUDA/cuDNN 运行库；应用内按需下载入口也必须保持关闭。

## 暂停范围

- Windows 构建脚本不再下载 NVIDIA wheel，也不复制 CUDA/cuDNN DLL。
- Linux AppImage 与 deb 不再注入 CUDA Provider。
- 应用不再保存旧 CUDA Release URL，安装命令只返回暂停说明。
- 旧运行库资产只保留在受控证据档案，不复制到新仓库或新 Release。

## 重新启用条件

- 法律顾问逐项确认目标版本、组件和目标平台的 NVIDIA 再分发权利。
- 新增来源、版本、哈希、许可原文和必需通知清单。
- 自动化检查验证包内文件与批准清单完全一致。
- GPU 就绪状态仍须来自真实 Provider 注册；任何失败只能回退 CPU，不能阻止启动。
