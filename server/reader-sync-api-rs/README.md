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

Windows 压测机需要快速复测隔离服务的直连链路时，从仓库根目录运行这一条命令：

```powershell
pwsh -NoProfile -File .\server\reader-sync-api-rs\scripts\run-capacity-test-windows.ps1
```

无参数时执行 50 个独立 VU、60 秒的 `catchup` 非容量短测。需要改变单轮负载或在一次准备中
顺序执行多轮时，直接传入：

```powershell
# 单轮：75 VU，90 秒
pwsh -NoProfile -File .\server\reader-sync-api-rs\scripts\run-capacity-test-windows.ps1 -Concurrency 75 -DurationSeconds 90

# 多轮：共用一次账户创建、直连准备和全局锁，依次执行三轮
pwsh -NoProfile -File .\server\reader-sync-api-rs\scripts\run-capacity-test-windows.ps1 -Rounds '25x60,50x60,100x90'
```

`Concurrency` 允许 1–500，`DurationSeconds` 允许 30–300 秒；`Rounds` 使用逗号分隔的
`并发x秒数`，不得与前两项混用，最多 12 轮且总负载不超过 1200 秒。多轮按顺序逐轮生成独立
报告；任一轮失败就停止后续轮次并进入统一清理。无论参数形状如何，生成的 probe/manifest 中
`workloadClass` 始终为 `non-capacity-diagnostic`，不能代替固定 20 分钟容量曲线。以上只是输入边界；每一轮仍必须覆盖
全部 2048 个账户、完整认领 VU shard 且无 cutoff，因此过短的低并发组合可能被测量完整性门禁拒绝。

它通过仓库外已配置的受限
管理员通道自动解析直连目标，为本次调用新建并验证 2048 个可销毁账户，临时启用测试服务原生
自签 HTTPS，并只放行当前压测机来源；测试期间同步采集 Windows 压测进程、API、PostgreSQL
和主机资源。无论成功或失败，都会精确删除本次调用的账户、恢复回环 HTTP、撤销临时防火墙与 TLS，
且不会把地址、Token、连接串或私密路径写入命令行和报告。

未配置候选摘要时，入口使用 `production-equivalent` 门禁：测试服务与生产服务必须运行在不同
路径、不同进程中，但运行中二进制必须字节一致。若隔离服务需要先验证尚未进入生产的原生 TLS
构建，只能把离线验证清单中预先批准的 64 位小写 SHA-256 写入仓库外私有配置的
`testBinarySha256`；匹配后报告标记为 `verified-candidate`。该标记只证明隔离服务命中了获批候选，
不表示候选与生产二进制相同，也不会部署、重启或切换生产服务。不得把远端临时计算出的摘要直接
回填为“批准”依据。

候选安装与摘要批准只在候选源码或二进制变化时做一次：先在本机产出并验证 Linux 二进制，再受控
上传到隔离服务。日常 Windows 一键复测不会编译、不会再次上传或替换候选二进制，也不会操作云控制台；
每次调用只传入并校验三个小型运行辅助脚本，结束后删除。只要候选摘要、直连目标和压测机公网出口没有
变化，后续仍执行同一条命令即可。公网出口变化时，必须先把云侧常驻规则收紧到新的单一 `/32`，不得
扩大为公网开放。运行器在发压前会从 Windows 直接访问测试服务的原生临时 HTTPS 端口，不使用系统
HTTP(S) 代理、不跟随重定向，也不经过 Caddy，并检查 `/health` 和 `/ready`；负载期间持续钉住 API
进程及可执行文件身份，监控报告停止刷新、监控链路中断或身份变化都会立即终止本地负载，再执行强制
恢复与账户清理。运行器还会在服务端稳定控制目录中持有覆盖整个测试生命周期、随机租约绑定的全局排他锁；
所有会改变临时直连状态或测试账户的远端命令都由持锁进程在 120 秒硬截止内执行，因此从其他报告目录或
另一台压测机启动的同类任务不会与本轮交叉清理。若连接在命令中途崩溃，入口会等待实际 flock 释放并以新租约
重做幂等清理；删除本轮临时目录不会删除锁的恢复控制面。
每次调用在创建账户前持久化登记不含 Token、地址或数据库名
的私有待清理标记；标记以数据库目标与 Token HMAC key 的组合摘要绑定并在允许 seed 前落盘。若上次意外
中断，下一次会先按原 fixture ID 自动精确清理，恢复失败则拒绝创建新账户。只有直连、账户和临时远端
目录均确认恢复、全局锁安全释放后，报告清单才会标记为完成。

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
