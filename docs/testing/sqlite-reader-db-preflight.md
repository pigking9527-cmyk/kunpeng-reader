# SQLite 大书库只读预检

本工具为 P3 的真实书库压测前置证据。它只适用于已获得明确授权的、**仓库外**
`reader.db` 副本；不替代阅读器运行时压测，也不读取或导出原书、书库路径、同步实体、
metadata 或账户信息。

## 做什么与不做什么

[`scripts/sqlite-reader-db-preflight.sh`](../../scripts/sqlite-reader-db-preflight.sh) 使用
SQLite `-readonly` 打开副本，并再次执行 `PRAGMA query_only = ON`。固定检查只有：

- `PRAGMA quick_check(1)`；
- 页面/空闲页和三个既有核心表的无内容行数聚合；
- `entities(kind, updated_at)` 最新项查询的 `EXPLAIN QUERY PLAN`。

报告只写聚合数字，以及该计划是否使用预期索引、是否出现 `entities` 全扫描或临时排序。
脚本不保存数据库路径、实体或 metadata 值、SQL、`EXPLAIN` 原文、书名、正文或查询词。
它不会创建索引、迁移、checkpoint、vacuum 或修改数据库；输出文件必须不存在并位于仓库外。

## 受控执行

先在受控位置准备副本及其所需 `-wal`/`-shm` 伴随文件（如存在）。只对拥有读取授权的
副本执行；不要把生产活动数据库路径作为参数，也不要把生成的 JSON 提交到仓库。

```sh
scripts/sqlite-reader-db-preflight.sh \
  --db /controlled-copy/reader.db \
  --output /controlled-records/reader-db-preflight.json \
  --confirm-authorized-reader-db
```

命令只在成功时输出“已写入仓库外的 SQLite 只读预检汇总记录”。失败时不会回显数据库
路径或 SQLite 原始错误。对结果的解释必须结合同一副本上的真实交互压测、锁等待指标和
`EXPLAIN QUERY PLAN` 私有审计进行；不要仅凭此静态快照决定引入连接池或更换索引。

## 下一步判定

预检通过后，在获授权的私有环境中：

1. 运行桌面端实际书架/同步高频路径，收集既有 `with_db_read` / `with_db_write` 锁等待与
   慢 SQL 指标；不能把实体 JSON 写入报告。
2. 对候选高频查询保存私有的原始 `EXPLAIN QUERY PLAN`，公开或仓库内只保留脱敏分类。
3. 使用 [全文索引对比流程](full-text-index-comparison.md) 在同一中文书库比较现有章节索引
   和临时 FTS5 候选。只有真实证据显示瓶颈后，才设计带备份/恢复独占关闭门控的只读连接池。

脚本自检仅创建临时空数据库，验证授权确认、仓库外输出、报告脱敏和只读访问：

```sh
scripts/test-sqlite-reader-db-preflight.sh
```
