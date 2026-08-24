# 情报分发 V1 部署前验收

此清单是 ADR-0036 和 `contracts/intelligence/` 的部署门，不是部署步骤。通过离线门只说明
源码保留了关键边界；**不能**替代受保护 PostgreSQL、备份恢复、断网恢复或权限隔离实测。
在所有真实环境验收完成前，情报接口不得接入反向代理、DNS、生产流量或客户端默认服务地址。

## 先执行的离线门

在干净、已提交的 checkout 执行下列命令。它们不读取部署环境变量、不连接数据库、不启动服务：

```bash
server/reader-sync-api-rs/scripts/check-intelligence-deployment-readiness.sh --offline
node scripts/test-intelligence-contracts.mjs
node scripts/test-intelligence-host-inference-contracts.mjs
cargo test --manifest-path server/reader-sync-api-rs/Cargo.toml --lib
cargo test --manifest-path server/reader-sync-api-rs/Cargo.toml --test intelligence_offline_contract
cargo clippy --manifest-path server/reader-sync-api-rs/Cargo.toml --all-targets -- -D warnings
server/reader-sync-api-rs/scripts/test-rehearsal-tools.sh
```

离线门检查 0023–0036 迁移连续性、30 日可见性、PURGING 回收器、发布/中转 capability
命名空间、上传大小上限、历史主机离线状态、对象存储位置约束、正式图片和历史包的持久
outbox，以及契约文件存在。`--require-object-storage` 仅证明源码存在 S3-compatible 适配器和
双写状态机；它不是 MinIO/S3 互操作或恢复验收的替代品。

真实对象存储必须由受保护环境显式执行，不能依赖普通测试中的“未配置即跳过”：

```bash
export KUNPENG_SYNC_TEST_DATABASE_URL='postgresql://.../reader_sync_rust_test_object_store'
export KUNPENG_SYNC_OBJECT_STORE_E2E_ENDPOINT='http://127.0.0.1:...'
export KUNPENG_SYNC_OBJECT_STORE_E2E_BUCKET='...'
export KUNPENG_SYNC_OBJECT_STORE_E2E_ACCESS_KEY_ID='...'
export KUNPENG_SYNC_OBJECT_STORE_E2E_SECRET_ACCESS_KEY='...'
# 先停止使用这一可销毁测试库的对象写入 worker；不得对生产服务设置此变量。
export KUNPENG_SYNC_OBJECT_STORE_E2E_QUIESCENT=1
server/reader-sync-api-rs/scripts/run-object-store-e2e.sh \
  --confirm-real-object-store-e2e
```

该入口会先迁移并验证该可销毁 PostgreSQL 测试库，再实际执行受限临时 key 的 PUT、Range
读取和删除，并验证 durable outbox 成功 PUT 后才把资产从 bytea 晋升为 S3。它不输出 endpoint、bucket、
密钥、数据库 URL、对象 key 或内容；缺少任一必需配置会拒绝运行。对象恢复仍需按本清单最后的
“必须实际证明的业务恢复”执行，不能用这一轮互操作测试替代。

真实 outbox 用例必须在该**可销毁测试库没有并发对象写入 worker**时运行。否则独立 worker
可能正确领取并提升同一测试对象，却会破坏“先以故障端点领取、再由恢复端点重试”的确定性
验证。运行脚本要求显式的 `KUNPENG_SYNC_OBJECT_STORE_E2E_QUIESCENT=1`，它只是一项人工
安全确认，不能替代停止并核实隔离 worker 的实际操作。

## 当前存储事实与容量边界

当前 V1 支持可选的 S3-compatible（含 MinIO）对象存储。禁用时，正式图片和历史临时包
仍由 PostgreSQL `bytea` 承载。启用时，完成上传先在同一数据库事务写入可读的 bytea 与
持久 outbox；后台 PUT 成功后才原子标记 `storage_backend='s3'` 并移除可读 bytea。对象写入
失败会退避重试；最终 ACK 或过期会先持久入 GC outbox，再在事务外删除对象。因此不得把
“配置了 bucket”或离线门通过误称为对象存储已验收。

无论是否启用对象存储，发布批准人都必须接受以下限制：

- 单张正式图片最多 25 MiB；单个历史临时包最多 128 MiB，二者均计入 PostgreSQL 的 WAL、
  备份、磁盘和复制预算。
- 30 日清理与 24 小时历史中转回收是降低存储量的机制，**不是**替代备份、容量预算或恢复
  演练的理由。
- 如果容量评估或恢复目标不能承受暂存 bytea、对象副本和其清理窗口，部署必须停止；不能靠
  未经验证的 bucket 宣称风险已解决。

## 迁移与发布候选

1. 使用新建的、可销毁的 `reader_sync_rust_test_*` PostgreSQL 数据库执行：

   ```bash
   export KUNPENG_SYNC_TEST_DATABASE_URL='postgresql://.../reader_sync_rust_test_intelligence_e2e'
   server/reader-sync-api-rs/scripts/run-postgres-e2e.sh --confirm-destructive-postgres-e2e
   ```

   运行器会同时执行 `postgres_intelligence_e2e`、
   `postgres_intelligence_asset_upload_e2e`、`postgres_intelligence_archive_recovery_e2e`、`postgres_intelligence_route_e2e` 与
   `postgres_intelligence_retention_route_e2e` 与 `postgres_host_inference_e2e`：前者实际查询 0023–0036 迁移后的
   `intelligence_publications_v1`、投递、图片、历史 job/upload、SSE event 和清理表，并确认
   当前图片/历史内容列确为 `bytea`；后者以两个已授权账号和一个禁用账号经过真实 Router 验证
   当前内容的访问边界，以及历史 request/content/ACK 不会跨账号读取或删除；资产上传测试确认完成后
   暂存 bytea 和进度计数均被清空、最终资产哈希可读；归档恢复测试通过
   认证 Router 覆盖 request、heartbeat、claim、分块断点续传、哈希下载、ACK 清包与失效 lease 重排；后者从认证
   Router 验证第 31 天清理后 feed 不再列出该包、publication/asset 均为 404，并确认归档日历
   不投影标题或正文。不得把离线 SQL 字符串测试当成此证据。

2. 在同一受保护环境，以两个不同的空/可销毁测试库执行逻辑备份恢复。脚本现在会核对同步
   数据以及 intelligence 正式包、图片、历史 job/上传、图片暂存和投递事件的行数：

   ```bash
   export KUNPENG_SYNC_BACKUP_SOURCE_DATABASE_URL='postgresql://.../reader_sync_rust_test_intelligence_source'
   export KUNPENG_SYNC_BACKUP_TARGET_DATABASE_URL='postgresql://.../reader_sync_rust_test_intelligence_restore'
   export KUNPENG_SYNC_BACKUP_REHEARSAL_DIR='/private/outside/repository'
   server/reader-sync-api-rs/scripts/run-postgres-backup-restore-rehearsal.sh \
     --confirm-destructive-postgres-backup-restore-rehearsal
   ```

   该演练会额外选取至少一条不超过 1 MiB 的图片和一条不超过 1 MiB 的历史包；在源库和恢复库
   分别读取实际 `bytea` 内容、解码后重新计算 SHA-256，并同时核对库内声明哈希。行数一致不是
   内容可读性的充分证据。测试库 URL、凭据、备份路径、内容、哈希与 dump 均不得进入仓库或日志。

3. 只从干净、已提交 checkout 构建候选并生成、复验溯源清单，依次使用
   `create-artifact-provenance.sh` 和 `stage-artifact-bundle.sh`。候选二进制、migration 和
   intelligence 契约 fixture 的 SHA-256 必须来自同一提交。

4. 生产 schema 迁移由**单一**受控实例执行。迁移前完成可恢复备份并写明当前 migration
   版本；migration 失败、服务健康检查失败或协议验证失败时，停止切流，恢复上一已验证二进制，
   再按备份恢复演练结果恢复数据库。不得用删表、手改 production SQL 或回滚 migration 文件
   作为“回滚”。

## 凭据、网络和 worker

- 服务运行配置先通过 `check-deployment-config.sh` 的离线解析。`KUNPENG_SYNC_TOKEN_HMAC_KEY`
  至少 32 字节，数据库 URL/SMTP/SMS 密钥来自受保护注入，不记录在 unit 文件、命令行、仓库、
  前端或日志。API 默认仅监听回环；公开 bind 需显式批准并由反向代理/TLS 边界保护。
- `intelligence:publish` 与 `intelligence:relay` credential 必须安装绑定、可撤销、过期受限，
  并与普通用户 session 使用不同 HMAC 域。实测：普通 Bearer 不能上传；撤销 publish 后不能
  创建/完成正式包；撤销 relay 后长轮询、claim、upload 立即被拒绝；凭据不在 worker 配置、
  stdout、事件或诊断中以明文出现。
- worker 只可出站 HTTPS 到批准的服务地址。验证 Windows 登录启动、主窗口关闭后继续、单实例、
  离线长轮询退避、网络恢复续传，以及撤销后无需重启即可停止后续发布/中转动作。
- SSE 只发送 `deliveryId`、cursor、kind；用两个不同账户验证 cursor、历史 request、ACK、
  本地缓存和图片鉴权均不能交叉可见。未登录 401、无权限/禁用会话 403 或断流。

## 必须实际证明的业务恢复

在隔离环境使用真实 PostgreSQL 和真实服务进程，至少一次完整执行：

1. 发布带图片的不可变包；草稿/缺图包不可见，完成后创建投递与 SSE 唤醒。
2. 推进或固定时钟到第 31 天；feed、publication、asset 和错误消息均不可读取内容；回收次序
   为 PURGING、投递、正文/引用、无引用图片、元数据。
3. 创建同日期历史请求，停止 worker 后快速达到 `HOST_OFFLINE`；恢复 worker 后 claim、分块
   上传、中断、按 offset 恢复、哈希校验、READY、下载落盘、ACK、立即逻辑删除并在五分钟内
   物理清理。
4. 不 ACK 的历史包在 24 小时内强制清理；重复 request/upload/ACK 使用相同幂等键且不产生额外
   内容、投递或通知。
5. 恢复数据库后重新运行上述最小流程，确认 bytea 暂存、对象清单及对象哈希、撤销状态、
   过期/清理状态和账号隔离均没有倒退。对象数据不在 PostgreSQL dump 内：必须按受保护的
   清单复制、恢复并用正常鉴权读取重新校验哈希。

所有上述证据应只保存在受保护运行记录中，使用计数、哈希、状态和时间；禁止记录书籍内容、
新闻正文、账户、token、数据库 URL、私有路径或真实源 URL。
