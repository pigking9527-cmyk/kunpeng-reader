# Rust 同步 API v5 PostgreSQL 演练

> 此文档只用于受保护的专用测试库和获批的 staging 演练。它不包含连接串、
> 账户、密钥、邮件地址、服务器地址或用户内容。

## 前置条件

1. 创建最小权限、可随时清空的 PostgreSQL 测试库；名称必须以
   `reader_sync_rust_test_` 开头。它绝不能是开发库、共享库或生产库。
2. 将数据库连接串、至少 32 字节的令牌 HMAC key 和 SMTP 配置放在受保护的
   环境变量/密钥系统中，不能写入 shell 历史、仓库或测试 fixture。
3. 获得维护窗口、备份保留策略、恢复目标库和反代/TLS 演练的明确授权。

## 真实数据库 E2E

先执行离线迁移清单检查；它不打开 PostgreSQL 连接：

```sh
server/reader-sync-api-rs/scripts/check-migrations.sh
```

在放入受保护的部署环境变量后，先运行下列离线解析检查。它不会连接数据库、启动
HTTP 监听器或输出机密：

```sh
server/reader-sync-api-rs/scripts/check-deployment-config.sh
```

随后在服务端目录执行。启动器要求一次性的、显式破坏性确认，验证测试库前缀，且从不
回显连接串。变量值只在当前受保护会话中设置：

```sh
export KUNPENG_SYNC_TEST_DATABASE_URL='postgresql://…/reader_sync_rust_test_isolated'
server/reader-sync-api-rs/scripts/run-postgres-e2e.sh --confirm-destructive-postgres-e2e
```

测试会执行迁移并多次 `TRUNCATE … CASCADE`。成功表示 Axum router 与真实
PostgreSQL 的认证、注册 outbox、反馈、改密/找回、实体同步、资产、清除及恢复
历史语义通过；它**不**覆盖独立 TCP 进程、反向代理、TLS 或真实 SMTP 投递。

## 幂等与限流负载演练

这不是公网压测工具：它不会启动监听器、读取生产地址或发送真实 HTTP 请求。它只对同一
受保护测试库中的 Axum Router 并发重放同一个同步 mutation，并重复提交匿名反馈以验证
持久化限流。执行前同样要求一次性确认、测试库前缀和环境变量；连接串不会输出：

```sh
export KUNPENG_SYNC_TEST_DATABASE_URL='postgresql://…/reader_sync_rust_test_isolated'
server/reader-sync-api-rs/scripts/run-postgres-load-rehearsal.sh \
  --confirm-destructive-postgres-load-rehearsal
```

当前固定演练断言：12 个并发同 mutation 的 push 都返回成功、只写入一张幂等收据和一个
实体；同一来源的第 4 次匿名反馈在一小时窗口内返回 `429`，且只有前 3 条被持久化。它是
部署前保护机制及并发语义 smoke test，不是容量结论。容量、P95/P99、CPU、连接池、反代
和真实网络压测必须在获批 staging 环境另行记录。

## 空库部署与回滚演练

1. 对空的 staging 数据库，首次以 `KUNPENG_SYNC_RUN_MIGRATIONS=1` 启动；确认
   `/health` 和需要数据库的 `/ready`。随后设为 `0` 后重启，确认迁移不会在
   正常运行时重复执行。
2. 用隔离账户完成：注册邮件、验证、登录、多设备 push/pull、幂等重放、资产
   分块/Range、密码修改和找回、恢复时间点、云端数据清除，以及旧 token/世代被拒绝。
3. 在写入测试数据后，按 PostgreSQL 运维方案创建逻辑备份和物理基备份；校验
   备份可读、在另一空目标库恢复、迁移版本和关键聚合与源库一致。记录仅可包含
   操作标签、schema version、行数和校验结果，不能包含实体 JSON、账号或路径。
4. 通过真实反向代理/TLS 运行健康、认证、同步和恢复 smoke test；确认应用只在
   回环监听且 `/metrics` 不对公网暴露。
5. 仅在上述证据、回滚入口和维护窗口已获批准后，才切换上游流量。若失败，停止
   切换并回到旧服务；不要把 v5 会话写入旧服务，也不要通过数据库复制伪造回滚。

当前仓库没有可执行的 PostgreSQL 备份/恢复或 systemd/反代部署脚本；这是一项
部署前缺口，必须在获批的私有运维环境中补齐并演练，不能用旧 Python/SQLite
脚本替代。

仓库内还提供不连接数据库的启动器拒绝路径自检：

```sh
server/reader-sync-api-rs/scripts/test-rehearsal-tools.sh
```
