# 私有同步历史投影的迁移门槛

## 状态

仅为 P3 的候选设计，**尚未实施**。当前运行时继续以 `metadata` 内的
`private_sync_ai_history_v1:<content-id>` JSON 作为本机历史的唯一事实来源。

## 已核实的瓶颈与不可改变的语义

当前每本智读历史保存在一个 JSON metadata 值中。以下操作会扫描所有此前缀的
metadata 并反序列化每个数组：

- `private_sync_reader_history_snapshot` 为手动/最近同步计算账户级 100 条集合；
- `private_sync_set_reader_history_cloud_saved` 在手动模式下统计已选择的条目；
- `materialize` 在启动投影或历史写入后生成独立的
  `ai_reader_history_entry_v2` 实体。

这不是可以把 JSON 读取、合并或序列化移到 SQLite 锁外的安全区域。历史写入命令、
下行同步、`materialize` 和账户级手动选择上限必须看到同一个版本；否则在锁外读取旧
数组后写回，会丢掉并发加入的回答、复活墓碑，或超过账户级 100 条限制。

现有单连接 SQLite + WAL 和 `AppState::with_db_read/write` 是备份/恢复可以独占关闭
`reader.db` 的前提。本设计既不引入连接池，也不改变同步实体或 API schema。

## 候选表

真实大书库的锁等待与 `EXPLAIN QUERY PLAN` 证明扫描是瓶颈后，可以新增仅本机的
`private_history_projection_v1`：

| 列 | 含义 |
| --- | --- |
| `scope` | `reader` 或 `library`；读者记录的 scope 固定为 `reader`。 |
| `content_id` | reader 为 64 位内容散列，library 为固定空值。 |
| `entry_id` | 与 `ai_reader_history_entry_v2` 的局部 ID 相同。 |
| `deleted_at` | 非零表示墓碑，墓碑必须胜过同 ID 的活跃记录。 |
| `at` | 用于 recent 模式的现有字符串时间排序。 |
| `cloud_saved` | 手动模式的选择位。 |
| `normalized_entry_json` | 与 metadata 中规范化条目逐字等价的本机副本，不是同步 payload。 |
| `source_generation` | 对应历史 metadata 的单调世代，用于崩溃恢复和一致性检查。 |

主键为 `(scope, content_id, entry_id)`。至少建立两个索引：

```sql
CREATE INDEX private_history_projection_recent_v1
  ON private_history_projection_v1(scope, deleted_at, at DESC, content_id, entry_id);
CREATE INDEX private_history_projection_manual_v1
  ON private_history_projection_v1(scope, cloud_saved, deleted_at, content_id, entry_id);
```

`at` 相同的记录必须以当前 `normalized_entries` 的确定性顺序打破平局（content ID、
entry ID），并用 fixture 验证；不能因改用 SQL 排序而静默改变 recent 的 100 条边界。

## 原子迁移与写入规则

1. schema 迁移先创建表、索引和 `private_history_projection_ready_v1` 标记，不能先设置
   ready 标记。
2. 在**一个 SQLite 写事务**中枚举旧前缀 metadata、解析并运行当前
   `normalized_entries` / `normalized_library_entries`、写入每本规范化 metadata、写入
   对应投影行及 generation；最后才设置 ready 标记。任一错误回滚整个事务。
3. 迁移前或标记缺失时，运行时仍走当前 metadata 路径；不得混读“部分投影 + 全量
   metadata”。迁移中断后下次启动重试该事务。
4. 每次历史 merge、删除、手动选择和下载合并都必须在一个写事务内：读取 canonical
   metadata，规范化/合并，写回 metadata，替换该 history key 的投影行，更新 generation，
   并物化受影响的 v2 实体。读取 snapshot 时只读 ready 的投影。
5. `materialize` 的 reader recent/manual 集合、活跃行和墓碑必须从同一事务快照取得。
   下行 `apply_downloaded_entities` 也必须在同一事务中更新 canonical metadata 与行投影，
   不能在锁外预先解析后回写。
6. SQLite 文件快照天然包含投影表；便携核心数据包继续排除它。恢复后若 schema 标记与
   行数校验不匹配，清除 ready 标记并从 canonical metadata 重建，绝不从云端实体反推本机
   完整历史。

## 实施前必须满足的证据

- 在获授权、仓库外的大书库副本上执行既有只读预检，并收集 `with_db_read/write` 的锁
  等待和锁内时长；不能记录正文、metadata 值、路径或账户信息。
- 保存私有 `EXPLAIN QUERY PLAN`，证明现有 metadata 全扫描是实际热点，并证明候选索引
  消除全表扫描/临时排序；仓库只保存脱敏的计划分类与聚合数据。
- 增加迁移前后等价测试：recent/manual 的 100 活跃和 200 墓碑上限、相同时间平局、
  手动选择、下载活跃/墓碑、旧 v1 数组迁移、损坏 metadata 以及中途失败回滚。
- 增加并发命令测试：本地 merge 与下行同一条目、手动选择竞争、迁移/备份/恢复互斥；
  证明不存在丢更新或墓碑复活。
- 在 macOS 的真实大书库压测中证明首屏/同步锁等待改善，再评估是否需要生命周期门控的
  只读连接池。投影表本身不是引入连接池的理由。

在这些条件完成前，保留现有 metadata JSON 和单连接事务边界比未经验证的“锁外解析”更
可靠。
