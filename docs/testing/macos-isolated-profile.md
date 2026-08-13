# macOS 隔离配置验收

`--isolated-profile <absolute-dir>` 用于在不读取或修改日常安装数据的前提下，启动一个独立的 macOS 验收配置。

```sh
/Applications/鲲鹏阅读器.app/Contents/MacOS/ebook-reader-tauri \
  --isolated-profile /absolute/path/to/empty-profile
```

隔离验收期间不要运行安装脚本、`open -a`、Dock/Finder 打开应用，或按应用名称附着的自动化工具；它们会启动不带参数的默认配置。始终使用上面的可执行文件命令启动，并在每一步操作前用 `ps` 确认仅有这一条带 `--isolated-profile` 参数的进程。

限制与行为：

- 只支持 macOS 14 及以上。低于该版本、非 macOS、相对路径、根目录、符号链接、重复参数、缺少参数，或没有标记的非空目录都会在创建窗口、SQLite 或默认应用数据前退出。
- 首次使用的空目录会创建仅当前用户可访问的 `0700` 根目录、不可猜测的 16 字节配置标识，以及 `config`、`cache`、`data` 子目录。随后只能使用带有效标记的同一目录。
- SQLite、书库/统计/生词本、备份、索引、模型、字体、背景、任务记录、日志、同步凭据引用和单实例锁均使用此配置目录；默认启动仍使用既有系统目录。
- 主窗口、阅读窗口和搜索窗口共享同一私有 `WKWebsiteDataStore` 标识；钥匙串服务名也由该标识区分。WebKit 自身管理的文件位置由系统决定，**不保证**全部可见文件位于传入目录下；隔离保证来自不同的数据存储标识，而非把 WebKit 文件移动到该目录。
- 隔离配置不会注册、复用或启动用户的开机自启/登录后台 LaunchAgent；设置页会把此能力显示为不可用。

验收前后应分别确认默认应用仍能看到原书架，而隔离实例从空书架启动。可记录：首次启动、导入 EPUB/PDF、阅读/选区/批注、关闭释放、搜索、清除本机数据，以及退出后再次使用相同配置目录的结果。不要将个人图书、账户、Token 或实际本机路径提交到仓库。

自动门禁：`cargo test --quiet`、`cargo clippy --all-targets -- -D warnings` 与 `cargo fmt --all -- --check`。结构性检查覆盖 CLI 拒绝条件、标记与权限、稳定配置标识、钥匙串/实例隔离标识，以及三个 WebView builder 的同一 data-store 标识。
