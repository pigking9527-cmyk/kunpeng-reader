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
5. 首次只在空库设置 `KUNPENG_SYNC_RUN_MIGRATIONS=1`，迁移完成后改回 `0`。
6. 在同一受保护会话中执行
   `server/reader-sync-api-rs/scripts/check-deployment-config.sh`。它只解析配置，不连接
   数据库、不绑定端口，也不会回显连接串或密钥。
7. 在上传二进制前，使用 `create-artifact-provenance.sh` 为已提交、干净的服务 checkout 创建
   并复验本地 SHA-256 溯源清单。它必须同时匹配源提交/树、`Cargo.lock`、编译期 v5
   entity fixture、全部 migration 和待上传二进制；未跟踪或有未提交改动的服务目录或 fixture
   会被拒绝，不能将该构建用于部署。
8. 仅在离线受控目录中用 `stage-artifact-bundle.sh` 将已复验候选物暂存为最小传输包；该包
   只能含二进制与 `provenance.txt`，并须再次复验后才可进入任何受保护传输流程。此步骤本身
   不具备上传、连接服务器、读取部署配置或切换服务的能力。

## 运行边界

- 默认监听 `127.0.0.1:8788`，公网 TLS 由同机 Nginx/Caddy 终止。
- 不直接暴露 `/metrics`；反向代理仅允许本机监控访问。
- 默认忽略所有代理 IP 头。只有反向代理与服务同机、且代理**覆盖写入** `X-Real-IP`
  时，才设置 `KUNPENG_SYNC_TRUST_LOOPBACK_PROXY_HEADERS=1`。不得把客户端传入的
  `X-Real-IP` 原样转发。
- 公网 bind 必须额外显式设置 `KUNPENG_SYNC_ALLOW_PUBLIC_BIND=1`，正式部署不建议这样做。

## 切换顺序

1. 保留旧服务配置与启动单元，不删除旧数据库。
2. 启动 Rust 服务到未对外的回环端口；验证 `/health` 为 200、`/ready` 为 200。
3. 在测试账户执行注册、登录、重复 push 幂等回放、pull、logout 和限流检查。
4. 仅切换反向代理上游；不同时改 DNS、数据库和客户端契约。
5. 观察 5xx、p95 延迟、数据库连接、SMTP outbox 与配额拒绝后再扩大流量。

上传前的离线产物清单只证明待上传文件与一个已提交源码树的对应关系，不证明部署、数据库
迁移、TLS 或 SMTP 已完成演练；这些仍是独立的受保护门禁。

## 回滚

若 readiness、认证、同步一致性或邮件投递异常，立即把反向代理上游切回旧服务，并停止
Rust 服务。v5 协议数据库不反向写回旧数据库；底层存储对象仍保留 `*_v4` 名称，因为
本次未改变载荷或表结构。由于当前尚无用户，可以丢弃失败试运行期间的开发数据并重新建空库。
正式出现用户后，本条破坏性回滚策略必须重新评审。
