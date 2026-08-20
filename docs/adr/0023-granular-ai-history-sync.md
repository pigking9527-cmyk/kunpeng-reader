# ADR-0023：逐条同步智读与书库问答历史

## 状态

已接受。

## 背景

`ai_reader_history_v1` 把一本书的一组智读记录（或全部书库问答记录）放入同一个实体。新增或删除一条记录会改变整份数组，因而客户端会重新提交完整历史，服务端也会为完整快照建立恢复版本。这会使一次小修改的网络流量、恢复存储和每日写入配额随历史总量线性增长。

## 决定

同步协议升级为 **v3**，新增 `ai_reader_history_entry_v2`。每个活跃或删除的历史条目都是一个独立实体：

- 单书智读 ID 为 `reader:<content-id>:<entry-id>`，payload 含 `version: 2`、`scope: "reader"`、`contentId` 与脱敏后的单条记录；
- 书库问答 ID 为 `library:<entry-id>`，payload 含 `version: 2`、`scope: "library"` 与脱敏后的单条记录；
- 删除使用实体级墓碑，不再嵌入共享数组。每个 scope 最多 100 条活跃记录与 200 条墓碑；超出后客户端先提交淘汰条目的墓碑。

历史仍首先写入本机完整历史；`off`、`recent`、`manual` 只决定哪些条目物化到同步实体。每条实体只保留提问/回答、生成时间、任务类型及来源书名、章节、材料类型；不得含正文摘录、`bookId`、路径、向量、嵌入、API Key 或模型输入。

客户端继续读取 `ai_reader_history_v1`，将已下载的数组条目一次性投影为 v2 独立实体；v1 是只读迁移来源，不再作为 v3 客户端的上传对象。服务端继续为 v1/v2 客户端保存和拉取 v1，避免已有安装立即中断；携带 `schema_version >= 3` 的 push 不得写入 `book_state_v2` 或 `ai_reader_history_v1`。

## 后果

新增一条历史只上传该条 JSON，并只创建该条恢复版本。历史大于配额时淘汰和删除也只发送相关条目墓碑。服务端需要按账户、scope 和实体状态执行数量限制，客户端需在上传时让墓碑先于新增实体提交。

`reading_progress_v1` 与 `reading_data_v1` 仍分别包含多个字段；它们的进一步拆分另行设计，不复用本 ADR 的实体 ID 或 payload。

## 验证

- 新增一条记录时 pending 队列只有一个 `ai_reader_history_entry_v2`；
- 删除一条记录时 pending 队列只有该条实体墓碑；
- 拉取 v1 数组后，下一轮同步生成等价 v2 单条实体且不会重新上传 v1；
- 服务端拒绝超出 100/200 条 scope 限制的 v2 写入，并拒绝 v3 写入 `book_state_v2` 与 v1 历史；
- fixtures 覆盖 ID、脱敏、迁移和墓碑优先级。
