# 仓库资料安全流程

服务器地址、登录账户、SSH 身份文件位置、远端部署路径、密码、Token、私钥和未脱敏交接资料不得进入 Git、Issue、PR 描述、Release Notes 或构建日志。

## 私密资料存放

- 将真实运维参数存放在仓库外的密码管理器或本机受保护环境变量中。
- 仓库中的部署脚本只接受命令行参数或环境变量；不得写入真实默认值。
- 公开说明只使用示例域名和占位符，且不展示真实账号、路径或身份文件位置。

## 开发与提交

首次克隆后运行：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-git-hooks.ps1
```

提交钩子会扫描暂存内容，阻止私钥、常见云/服务 Token、SSH 登录到 IP、身份文件路径、明文凭据赋值和私密交接文档。平台公开说明仅允许 `ANDROID_HANDOFF.md`，新增例外必须经过人工安全审查。

## 发布

不得使用 `git add -A`、`git commit -a` 或 GUI 的“暂存全部”完成发布。使用明确文件列表：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/stage-release.ps1 -Path Cargo.toml,tauri.conf.json,README.md,README.en.md,CHANGELOG.md,开发记录.md,开发文档.md,server/reader-sync-api/updates.json
git diff --cached --name-status
```

如需更新服务器发布清单，在仓库外设置 `KUNPENG_RELEASE_SERVER`、`KUNPENG_RELEASE_IDENTITY_FILE` 与 `KUNPENG_RELEASE_REMOTE_PATH`，或在命令行显式传入；不要将这些值写回脚本。

CI 会对所有受跟踪文件执行同一检查。CI 失败不应通过修改规则或新增白名单规避；应先移除敏感资料并轮换已经暴露的凭据。