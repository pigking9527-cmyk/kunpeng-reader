# Windows 情报后台 worker 生命周期

情报发布主机的永久档案与 worker 不由情报中心页面持有。Windows 端使用
`kunpeng-intelligence-worker.exe --service-loop` 作为独立进程；关闭主窗口时，
主进程按既有启动增强策略隐藏并保留，worker 不依赖 WebView 或窗口存在。

## 配对与撤销边界

仅已经登录的账户可调用原生 `pair_intelligence_worker`。配对请求必须指定与当前
登录账户相同的 HTTPS 服务地址，并同时提供 `intelligence:publish` 和
`intelligence:relay` capability credential。

- 凭据只作为原生调用的入站字段；状态响应、日志、worker 标准输出、注册表命令行、
  环境变量和进程参数都不得包含凭据。
- Windows 将每个 capability token 用当前用户的 DPAPI 保护，写入
  `%APPDATA%\\ebook-reader\\intelligence-worker-v1.json`。该文件只保存不透明密文、
  开关和服务地址，不保存明文 token、同步 Bearer、账户 ID 或档案路径。
- `revoke_intelligence_worker_credential` 接受 `publish`、`relay` 或 `all`，立即清除
  对应本地 DPAPI 密文；撤销最后一个 credential 时移除本机记录和登录启动项。运行中的
  worker 每轮重新读取记录，故后续动作不能继续使用已撤销的本机 capability。
- 此处的“撤销”是**本机撤销**。服务器端仍以 capability credential 的
  `revoked_at`/过期/安装绑定为权威；服务端撤销必须由受控发布主机管理面执行，不能把
  server credential 颁发或撤销权交给普通客户端。

## 登录与安装

成功配对时写入当前用户的 Windows Run 项 `KunpengReaderIntelligenceWorker`，其值仅为
已安装 worker 的绝对路径和 `--service-loop`。登录启动项没有 token。worker 会自行从
DPAPI 记录读取配对凭据；它不接受凭据环境变量作为生命周期路径。

NSIS 包把 worker 放在应用 `resources/kunpeng-intelligence-worker.exe`；日常 Fast/Release
构建把同一 worker 放在阅读器可执行文件旁。生命周期启动器只探测这两个安装拥有的
位置，绝不从 `PATH`、当前目录或用户输入路径寻找可执行文件。构建 Windows 包前必须
使用 `cargo build --release --bins`，否则 Tauri 的资源门会拒绝缺失 sidecar。

`--service-loop` 持有进程级 Windows mutex：Windows Run 与阅读器启动可能同时发生，
第二个 worker 会成功退出而不是并发写入永久 SQLite 档案。配对路径不会试图通过 PID
或可见窗口判断已有 worker。

## 本地验证

```powershell
cargo test --bin kunpeng-intelligence-worker -j 1
cargo check --bin ebook-reader-tauri -j 1
cargo clippy --bin ebook-reader-tauri --bin kunpeng-intelligence-worker -- -D warnings
```

定向测试必须证明：持久化 JSON 不含明文 credential，普通/损坏配置拒绝读取，状态投影
不含 credential 或服务 URL，且只有安全 HTTPS 地址和无空白 ASCII capability token 可
通过。不要把真实凭据、应用配置文件或 Windows Run 注册表导出到仓库、Issue 或测试数据。
