# Reader Sync API (Rust)

鲲鹏阅读器的 Rust 同步服务。本目录是独立 Cargo workspace，不改写桌面端的
`Cargo.lock`。

## 本机启动

```bash
export KUNPENG_SYNC_DATABASE_URL='postgresql://...'
export KUNPENG_SYNC_TOKEN_HMAC_KEY='at-least-32-random-bytes'
export KUNPENG_SYNC_RUN_MIGRATIONS=1 # 只对全新的 v5 协议数据库开启
export KUNPENG_SYNC_SMTP_HOST='smtp.example.com'
export KUNPENG_SYNC_SMTP_PORT='587'
export KUNPENG_SYNC_SMTP_TLS_MODE='starttls' # 或 implicit（通常为 465）
export KUNPENG_SYNC_SMTP_FROM='鲲鹏阅读器 <noreply@example.com>'
export KUNPENG_SYNC_SMTP_USERNAME='...'
export KUNPENG_SYNC_SMTP_PASSWORD='...'
# 仅当同机反向代理覆盖写入 X-Real-IP 时开启
export KUNPENG_SYNC_TRUST_LOOPBACK_PROXY_HEADERS='1'
cargo run --manifest-path server/reader-sync-api-rs/Cargo.toml
```

默认只监听 `127.0.0.1:8788`。`/health` 是存活检查，`/ready` 会读取 PostgreSQL，
`/metrics` 只应由回环监控或反向代理访问，`/openapi.json` 提供机器可读 API 说明。

## 验证

```bash
cargo fmt --manifest-path server/reader-sync-api-rs/Cargo.toml --check
cargo clippy --manifest-path server/reader-sync-api-rs/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path server/reader-sync-api-rs/Cargo.toml
```

PostgreSQL 端到端测试默认跳过。只有显式设置数据库名以
`reader_sync_rust_test_` 开头的 `KUNPENG_SYNC_TEST_DATABASE_URL` 时，测试才会迁移并
清空该库；不得把开发库或生产库传给此变量。

先运行不连接数据库的迁移清单检查：

```bash
server/reader-sync-api-rs/scripts/check-migrations.sh
```

在受保护的部署会话中可额外解析实际运行环境变量；此检查不连接 PostgreSQL、不启动
服务且不输出连接串或密钥：

```bash
server/reader-sync-api-rs/scripts/check-deployment-config.sh
```

只有在已获批、可清空的测试库中，才可用下列命令实际执行 E2E。脚本既不打印连接串，
也不会因缺少显式破坏性确认而运行测试：

```bash
server/reader-sync-api-rs/scripts/run-postgres-e2e.sh --confirm-destructive-postgres-e2e
```

针对幂等重放和持久化限流的本地 Router 并发演练使用独立确认词；同样只允许名称以
`reader_sync_rust_test_` 开头的可清空测试库，且绝不输出连接串：

```bash
server/reader-sync-api-rs/scripts/run-postgres-load-rehearsal.sh \
  --confirm-destructive-postgres-load-rehearsal
server/reader-sync-api-rs/scripts/test-postgres-backup-restore-rehearsal.sh
```

可在 CI 或本机执行仅覆盖拒绝路径的安全自检：

```bash
server/reader-sync-api-rs/scripts/test-rehearsal-tools.sh
```

获批的隔离 PostgreSQL 环境还可执行逻辑备份/恢复演练。脚本只接受两个不同的
`reader_sync_rust_test_*` 数据库和仓库外私有临时目录；它从不回显连接串，完成后删除
临时 dump，并仅比较协议版本与关键表的行数汇总：

```bash
server/reader-sync-api-rs/scripts/run-postgres-backup-restore-rehearsal.sh \
  --confirm-destructive-postgres-backup-restore-rehearsal
```

在任何上传到受保护部署环境的操作前，先以**已提交且服务目录干净**的 checkout 产出 Linux
二进制，再创建并立即复验本地溯源清单。清单不包含路径、连接串或密钥，只记录当前源提交/树、
`Cargo.lock`、每个 migration 与二进制的 SHA-256；若服务源码未被 Git 跟踪或有未提交改动，
工具会拒绝生成，不能把二进制错误归属到旧提交：

```bash
cargo build --release --locked --manifest-path server/reader-sync-api-rs/Cargo.toml
server/reader-sync-api-rs/scripts/create-artifact-provenance.sh \
  --binary server/reader-sync-api-rs/target/release/reader-sync-api \
  --output /secure-local-output/reader-sync-api.provenance
server/reader-sync-api-rs/scripts/create-artifact-provenance.sh \
  --verify \
  --binary server/reader-sync-api-rs/target/release/reader-sync-api \
  --manifest /secure-local-output/reader-sync-api.provenance
server/reader-sync-api-rs/scripts/stage-artifact-bundle.sh \
  --binary server/reader-sync-api-rs/target/release/reader-sync-api \
  --manifest /secure-local-output/reader-sync-api.provenance \
  --output-dir /secure-local-output/reader-sync-api-candidate
server/reader-sync-api-rs/scripts/stage-artifact-bundle.sh \
  --verify \
  --bundle-dir /secure-local-output/reader-sync-api-candidate
server/reader-sync-api-rs/scripts/test-artifact-provenance.sh
server/reader-sync-api-rs/scripts/test-artifact-bundle.sh
```

暂存包只包含经复验的候选二进制和 `provenance.txt`；它拒绝符号链接、额外文件及与
清单不符的内容。上述工具均不上传文件、不会连接数据库或服务器，也不会替代
PostgreSQL/反代/TLS 演练。

生产切换之前必须额外完成契约验证、空库部署和回滚验证。

## 当前实现范围

- 已实现：存活/就绪、Prometheus、OpenAPI、请求 ID、并发/超时/请求体保护、
  Argon2id、不可还原会话摘要、最多五台活跃设备、登录/身份查询/会话/注销、带七天幂等回放的
  v5 最小 push/pull、符合 `contracts/auth/registration-v2.md` 的两阶段注册、受当前会话授权的
  登录密码修改（保留当前会话、撤销其他会话）、符合 `contracts/auth/password-reset-v2.md` 的
  已验证邮箱密码找回（单次挑战、撤销所有旧会话并为当前安装签发新会话）、邮件
  outbox 和强制 TLS SMTP 投递 worker（支持隐式 TLS 与 STARTTLS）。SMTP 未配置时注册入口明确不可用；注册限流键
  HMAC 后持久化，同步执行 25 MiB 总量及每日 10 MiB/3000 实体配额；匿名 `POST /v1/feedback`
  使用持久化限流与 PostgreSQL 收件箱，严格校验契约中的图片和可选 Bug JSON 附件，并返回
  `acceptedAttachments`。反馈不会复用注册 SMTP 配置，因此当前响应始终明确 `emailed: false`；
  `POST /v1/sync/data/reset` 会在同一 PostgreSQL 事务中复核当前密码、递增数据世代、清空 v5
  同步实体/收据/当日配额和背景资产并撤销所有会话；背景资产使用认证的、最多 10 MiB 的
  顺序 1 MiB 分块上传与 Range 下载，服务端验证 SHA-256 并将其计入账户总量和每日写入配额。
- 已实现：认证的恢复历史状态与确认恢复；只对实际接受的非密钥包实体写入压缩完整版本，
  保留 90 天历史和每实体窗口前锚点。恢复会生成必要墓碑、递增数据世代并撤销全部会话。
  该服务仍未部署，生产前须在受保护的 PostgreSQL 测试库完成端到端演练。
- v5 只部署到全新数据库；不导入旧账户、会话、实体、恢复历史或资产。既有存储对象保留
  `*_v4` 名称，因为本次只升级协议门禁，不改变载荷。正式
  `/v1/auth/*` 与 `/v1/sync/*` 已切到 Rust，旧无前缀接口只保留为短期回滚边界。
