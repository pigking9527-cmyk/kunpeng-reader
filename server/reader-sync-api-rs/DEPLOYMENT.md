# Rust 同步服务 v5 部署

本服务是破坏性的新数据库基线，不在旧 Python schema 上原地升级，也不导入旧开发数据。
以下示例不包含真实服务器地址、账号、密码、路径或 Token。

## 前置门禁

1. 使用 Rust 1.97.1 和本目录已提交的 `Cargo.lock` 执行 `cargo build --release --locked`。
2. 创建独立、空的 PostgreSQL 数据库与最小权限角色；不复用旧服务数据库。
3. 生成至少 32 个随机字节的 `KUNPENG_SYNC_TOKEN_HMAC_KEY`，只保存在服务器密钥存储或
   root 可读环境文件中。
4. 配置强制 TLS SMTP（`starttls` 或 `implicit`）；未配置时服务可启动，但注册明确返回
   `REGISTRATION_UNAVAILABLE`。
5. 如启用手机注册，在服务器密钥存储中整组配置腾讯云短信 SecretId/SecretKey、SMS 应用 ID、
   已审核签名正文和已审核模板 ID；模板变量必须按“验证码、有效分钟数”排列。设置每日发送
   上限并在云平台另设费用告警/预算。任何值不得进入仓库、日志或客户端。
6. 首次只在空库设置 `KUNPENG_SYNC_RUN_MIGRATIONS=1`，迁移完成后改回 `0`。
7. 在同一受保护会话中执行
   `server/reader-sync-api-rs/scripts/check-deployment-config.sh`。它只解析配置，不连接
   数据库、不绑定端口，也不会回显连接串或密钥。
8. 在上传二进制前，使用 `create-artifact-provenance.sh` 为已提交、干净的服务 checkout 创建
   并复验本地 SHA-256 溯源清单。它必须同时匹配源提交/树、`Cargo.lock`、编译期 v5
   entity fixture、全部 migration 和待上传二进制；未跟踪或有未提交改动的服务目录或 fixture
   会被拒绝，不能将该构建用于部署。
9. 仅在离线受控目录中用 `stage-artifact-bundle.sh` 将已复验候选物暂存为最小传输包；该包
   只能含二进制与 `provenance.txt`，并须再次复验后才可进入任何受保护传输流程。此步骤本身
   不具备上传、连接服务器、读取部署配置或切换服务的能力。

## 运行边界

- 默认监听 `127.0.0.1:8788`，公网 TLS 由同机 Nginx/Caddy 终止。
- 不直接暴露 `/metrics`；反向代理仅允许本机监控访问。
- 默认忽略所有代理 IP 头。只有反向代理与服务同机、且代理**覆盖写入** `X-Real-IP`
  时，才设置 `KUNPENG_SYNC_TRUST_LOOPBACK_PROXY_HEADERS=1`。不得把客户端传入的
  `X-Real-IP` 原样转发。
- 公网 bind 必须额外显式设置 `KUNPENG_SYNC_ALLOW_PUBLIC_BIND=1`，正式部署不建议这样做。
- 服务默认将普通安全读取、轻量 checkpoint 与状态变更放入独立的有界执行槽：
  `KUNPENG_SYNC_MAX_CONCURRENT_REQUESTS=12`、
  `KUNPENG_SYNC_MAX_CONCURRENT_CHECKPOINT_REQUESTS=18`、
  `KUNPENG_SYNC_MAX_CONCURRENT_WRITE_REQUESTS=10`，合计最多 40 个执行请求。
  当执行槽已满时，读取/checkpoint/写入分别最多进入 64/24/48 个等待位；写入等待位
  只吸收短时 push 突发，不增加 10 个写执行槽的 CPU 与 PostgreSQL 并发预算。请求只在
  `KUNPENG_SYNC_REQUEST_QUEUE_TIMEOUT_MILLIS=200` 内等待空位；等待位已满或超时会返回
  `503 SERVER_BUSY` 和 `Retry-After: 1`。不要只把一个全局并发数盲目调高：必须同时观察
  PostgreSQL 连接等待、`reader_sync_request_queue_wait_seconds`、
  `reader_sync_request_queue_rejections_total`（按模板路由、read/write 和拒绝原因）及每路由
  5xx。单账户的同步写入仍由事务锁串行化，这是正确性约束而非可通过加槽消除的瓶颈。
- PostgreSQL 连接获取默认最多等待
  `KUNPENG_SYNC_DATABASE_ACQUIRE_TIMEOUT_MILLIS=300`；该上限只容忍短时连接交接，不扩大
  既定连接池或 10 个写执行槽。
- 认证、已认证账户准入和同步业务 SQL 在单个请求内复用同一条 PostgreSQL
  连接；权威 session/禁用查询仍每次执行，准入仍在业务 SQL 之前。不要为了追求
  更高并发而把这些阶段恢复为多次 pool acquire，否则在连接池满时会放大排队。
- session `last_used_at` 只使用有界的 O(1) 本地审计写抑制缓存；它不缓存任何
  正向授权结果。每次请求仍在 PostgreSQL 检查撤销、过期和禁用，不得用 TTL 或
  仅 `LISTEN/NOTIFY` 的缓存取代。
- 单账户每分钟准入的 PostgreSQL 租约按 8→16→32 自适应增长，并以账户/时间窗
  singleflight 合并并发补租。已持有数据库连接的竞争者不等待本地锁，而是立即返回
  可重试 503，避免单个热账户占满整个连接池。这些优化不改变持久化的每账户上限或
  fail-closed 语义。
- checkpoint 高水位与账户 generation 保存在同一主键行，实体事务通过 statement-level
  trigger 原子推进，重置原子清零。push 在账户锁后合并收据/generation 点查，并把
  存储账本/每日额度合并为一条 CTE；跨实例锁、幂等哈希和超限整事务回滚仍保留。
- 初次容量调优应从独立压测库开始。若提高数据库池上限，连接总预算必须包含主服务、演练实例、
  维护任务和 PostgreSQL 保留连接；不得超过 PostgreSQL `max_connections`。
- API 域名不能对客户端隐藏。正式域名应代理到边缘 WAF/CDN，源站仅允许边缘回源或使用出站
  tunnel；同一源 IP 不得保留可绕过边缘的 DNS-only 记录。若源 IP 曾公开，切换后应更换。
- 边缘层对手机发送路由启用路径/IP 挑战和限速，服务端多维持久化限流仍必须保留。

## 切换顺序

1. 保留旧服务配置与启动单元，不删除旧数据库。
2. 启动 Rust 服务到未对外的回环端口；验证 `/health` 为 200、`/ready` 为 200。
3. 在测试账户执行邮箱注册、登录、重复 push 幂等回放、pull、logout 和限流检查。启用短信时
   仅用批准的测试号码验收一次发送、投递状态、确认、错误码和每日熔断，不在日志记录号码。
4. 仅切换反向代理上游；不同时改 DNS、数据库和客户端契约。
5. 观察 5xx、p95 延迟、数据库连接、SMTP outbox 与配额拒绝后再扩大流量。

上传前的离线产物清单只证明待上传文件与一个已提交源码树的对应关系，不证明部署、数据库
迁移、TLS 或 SMTP 已完成演练；这些仍是独立的受保护门禁。

## 回滚

若 readiness、认证、同步一致性或邮件投递异常，立即把反向代理上游切回旧服务，并停止
Rust 服务。v5 协议数据库不反向写回旧数据库；底层存储对象仍保留 `*_v4` 名称，因为
本次未改变载荷或表结构。由于当前尚无用户，可以丢弃失败试运行期间的开发数据并重新建空库。
正式出现用户后，本条破坏性回滚策略必须重新评审。
