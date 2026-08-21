# ADR-0035：可选同步 checkpoint 会话捷径

- 状态：接受
- 日期：2026-08-14

## 背景

常规同步的完整性依赖 pull、inventory 与 reconcile。对于没有本地待上传变更、且已完整
应用服务端增量的客户端，重复扫描实体元数据来构造 inventory digest 会占用 PostgreSQL
CPU，却通常只得到“没有变化”的结果。

## 决定

新增可选、只读的 `GET /v1/sync/checkpoint`。客户端提交当前 `dataGeneration` 和最后完整
应用的 cursor；服务端在同一轻量查询中读取账户世代及该账户实体流的最高 cursor。

1. 世代不同返回 `409 DATA_GENERATION_MISMATCH`；客户端回到现有世代恢复流程。
2. `caughtUp` 仅在请求 cursor 与服务端高水位完全相等时为 true。大于高水位也不视为同步，
   防止损坏 cursor 跳过数据。
3. 只有无本地待上传变更、上次 pull `hasMore: false` 的客户端可据此跳过**本轮**
   pull、inventory/reconcile。客户端每小时必须执行一次既有完整流程；false、网络错误、
   协议错误和周期自愈也使用既有完整流程。
4. endpoint 只减少一次认证后的 inventory 扫描；不接收实体、不写入数据库、不替换
   push/pull/inventory/reconcile，也不改变 v5 或旧端点语义。

## 后果

稳态无变更同步变为认证读取加一个高水位索引查询，而不是一次空 pull 加实体元数据全量
读取。它不是 Merkle 摘要或变更日志；后续若引入这两项，必须单独定义跨端契约、保留策略和修复语义。
