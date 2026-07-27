# 同步实体约定

所有同步实体应具备稳定 ID、实体种类、更新时间、删除墓碑、来源设备和版本/冲突信息。实体内容按 `kind` 区分，客户端应忽略自己不认识的可选字段。

当前最小实体范围：

- `reading_progress`
- `bookmark`
- `highlight`
- `annotation`
- `rating`
- `tag`
- `booklist`
- `booklist_item`
- `vocabulary`
- `reading_stat`

`entities.schema.json` 是契约抽取时的结构底座，不代表已替代服务端运行时校验。任何收紧字段要求的修改都要先验证旧客户端兼容性。
