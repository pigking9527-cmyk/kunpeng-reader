# ADR-0011：同步实体时间使用 Unix epoch 毫秒

## 状态

已接受。

## 背景

桌面端、服务端的 `server_updated_at` 以及 ADR-0010 的核心状态迁移包都已使用 Unix epoch 毫秒；现实中已发布的 Android 客户端则把同步实体的 `updated_at`、`deleted_at` 写成 Unix epoch 秒。LWW 直接比较整数，混用单位会使同一时刻的毫秒值总是大于秒值，从而错误地覆盖较新的实体或阻止较新的编辑上传。

`cursor`、`server_updated_at` 和账户 `data_generation` 是独立的服务端同步状态，不能因实体时间单位调整而转换。

## 决定

同步实体包络的 `updated_at` 与 `deleted_at` 的规范单位为 Unix epoch **毫秒**。活跃实体的 `deleted_at` 为 `0`；墓碑的 `deleted_at` 为生成墓碑时的毫秒值。LWW 继续按 `updated_at`、`sync_version`、`device_id` 的既有顺序比较，且比较前两边必须处于同一规范单位。

服务端在 `/sync/push` 与 `/sync/reconcile` 的入站元数据边界兼容现实旧 Android 的 Unix epoch 秒：仅当非零值落在 2000-01-01T00:00:00Z 至 2100-01-01T00:00:00Z 的合理秒级 epoch 范围内时，乘以 1000 后再比较、存储或返回。其他数值不猜测单位，原样保留；这保留了开发、测试和历史修复中使用 `100`、`200` 等合成小时间戳的 LWW 语义。

本轮服务端不改写既有生产数据库。对历史存量秒级实体，服务端在 LWW 比较、inventory 摘要和 API 响应时按同一规则临时规范化，因此 pull 与冲突响应仍返回毫秒规范实体；`server_updated_at` 保持原值。经授权、备份与恢复演练后，才可另行发布一次、可记录的物理存量迁移。旧 Android 仍可继续发送秒级实体，但会收到毫秒规范的服务端实体/接受结果；客户端升级后应将本地同步实体及 acknowledgement 元数据一次性迁移为毫秒。

本变更保持 `syncProtocolVersion: 1`：旧输入由服务端兼容，API 不新增或移除字段。服务端发布应先于客户端统一时钟发布。若需回滚，继续运行兼容规范化逻辑；本轮没有物理存量转换，因而无需反向改写数据库。未来若获授权执行物理迁移，应先完成备份与恢复演练，且不得把所有毫秒实体降回秒。

## 后果

- ADR-0010 的迁移包可原样导入客户端，并在下一次正常 pull-before-push 中与服务端 LWW 安全比较；
- `cursor`、`server_updated_at`、`data_generation` 和同步 acknowledgement 的协议角色与单位不变；
- 服务端兼容窗口仅处理明确的现实 epoch 秒，避免把测试或异常小整数静默改写；
- 各客户端必须停止产生秒级实体，并对已有本地实体/ack 执行一次性、可恢复的毫秒迁移；服务端历史存量的物理迁移在单独授权前保持延后。

## 验证

服务端覆盖以下情形：秒级 push 正规化后 pull 返回毫秒；毫秒 push 原样保留；秒级 manifest 可与毫秒服务端实体正确 reconcile；历史存量秒级实体在不改写数据库的前提下以毫秒响应；合成小时间戳仍按原值进行 LWW 比较。
