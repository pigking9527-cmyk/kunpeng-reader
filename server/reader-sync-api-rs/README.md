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
# 可选手机号注册：必须整组配置；模板变量顺序为“验证码、有效分钟数”
export KUNPENG_SYNC_TENCENT_SMS_SECRET_ID='...'
export KUNPENG_SYNC_TENCENT_SMS_SECRET_KEY='...'
export KUNPENG_SYNC_TENCENT_SMS_SDK_APP_ID='...'
export KUNPENG_SYNC_TENCENT_SMS_SIGN_NAME='已审核签名正文'
export KUNPENG_SYNC_TENCENT_SMS_TEMPLATE_ID='已审核模板 ID'
export KUNPENG_SYNC_TENCENT_SMS_REGION='ap-guangzhou'
export KUNPENG_SYNC_TENCENT_SMS_DAILY_SEND_LIMIT='100'
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

### 容量压测（一键运行）

容量压测始终针对隔离、可销毁的 v5 PostgreSQL 测试服务，而不是正式服务。将部署目标、
至少 2048 个独立测试账户的临时令牌文件和远程监控脚本路径保存在仓库外的私有环境变量后，
压测机只需运行：

```bash
server/reader-sync-api-rs/scripts/run-capacity-test.sh --short
server/reader-sync-api-rs/scripts/run-capacity-test.sh --full
```

Windows 压测机需要快速复测生产等价二进制的直连链路时，从仓库根目录运行这一条命令：

```powershell
pwsh -NoProfile -File .\server\reader-sync-api-rs\scripts\run-capacity-test-windows.ps1
```

该入口固定执行 50 个独立 VU、60 秒的 `catchup` 非容量短测。它通过仓库外已配置的受限
管理员通道自动解析直连目标，为本轮新建并验证 2048 个可销毁账户，临时启用测试服务原生
自签 HTTPS，并只放行当前压测机来源；测试期间同步采集 Windows 压测进程、API、PostgreSQL
和主机资源。无论成功或失败，都会精确删除本轮账户、恢复回环 HTTP、撤销临时防火墙与 TLS，
且不会把地址、Token、连接串或私密路径写入命令行和报告。该结果只用于一分钟链路诊断，
不能替代 20 分钟容量曲线。

`--short` 固定为每个阶段 30 秒（总计 330 秒），适合确认最近改动；`--full` 固定执行
20 分钟的 5、75、150、200、250、300、350、400、450、500、25 并发曲线。运行器先在
测试服务主机启动 CPU/RSS/可用内存采样，再从独立压测机以 k6 保活连接运行请求混合，并保存
P50/P95/P99、状态和失败类别；本机 k6 的 CPU/RSS 也单独采样。每阶段都会原子更新 probe
报告，因此链路中断不会丢失已完成阶段。

默认目标应是 SSH localhost 隧道。只有测试端口已被云防火墙限制为压测机当前公网 `/32`
时，才设置 `KUNPENG_CAPACITY_ALLOW_EXTERNAL_TARGET=1` 使用直连；该端口不得进入反向代理
或改成全网开放。所需环境变量及安全边界可由 `run-capacity-test.sh --help` 查看，脚本不包含
任何地址、数据库连接串或凭据。

开发测试服务还提供不发送负载的 `--diagnose`，用于读取脱敏的并发/描述符/监听队列与
硬件配置；`--tune-capacity-host`、`--install-capacity-build-toolchain` 和
`--deploy-capacity-candidate` 仅接受名字显式标识为可销毁测试服务的目标。后两者用于把当前
本地服务端源码构建为测试候选，绝不是正式发布或切流机制。

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
  outbox 和强制 TLS SMTP 投递 worker（支持隐式 TLS 与 STARTTLS）。SMTP 未配置时邮箱注册
  明确不可用；注册限流键 HMAC 后持久化。另实现可选的手机两阶段注册：只接受 E.164 号码，通过服务端腾讯云
  TC3-HMAC-SHA256 短信适配器投递，供应商接受前不能确认；完整号码和验证码只存在于短时
  outbox，长期只保存 keyed HMAC 摘要及末四位，并有手机号/IP/网段/安装 ID/全局限流和每日
  费用熔断。短信配置缺失时手机号入口 fail closed，不影响邮箱注册。同步执行 25 MiB 总量及
  每日 25 MiB/10,000 实体上传配额；拉取和新设备恢复下载不计入该额度。匿名 `POST /v1/feedback`
  使用持久化限流与 PostgreSQL 收件箱，严格校验契约中的图片和可选 Bug JSON 附件，并返回
  `acceptedAttachments`。反馈不会复用注册 SMTP 配置，因此当前响应始终明确 `emailed: false`；
  `POST /v1/sync/data/reset` 会在同一 PostgreSQL 事务中复核当前密码、递增数据世代、清空 v5
  同步实体/收据/当日配额和背景资产并撤销所有会话；背景资产使用认证的、最多 5 MiB 的
  顺序 1 MiB 分块上传与 Range 下载，服务端验证 SHA-256 并将其计入账户总量和每日写入配额。主题删除后，未被任何活动主题引用的资产延迟七天回收。
- 云端历史版本恢复已移除；服务端不保存实体版本历史，也不提供恢复状态或恢复接口。
- v5 只部署到全新数据库；不导入旧账户、会话、实体或资产。既有存储对象保留
  `*_v4` 名称，因为本次只升级协议门禁，不改变载荷。正式
  `/v1/auth/*` 与 `/v1/sync/*` 已切到 Rust，旧无前缀接口只保留为短期回滚边界。
