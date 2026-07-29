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

可选私密扩展（旧客户端必须忽略而不能删除）：

- `ai_reader_config_v1`：智读服务商、接口地址和模型名，不含 API Key；默认同步。
- `translation_config_v1`：翻译服务的非敏感偏好，不含凭据；默认同步。
- `ai_reader_history_v1`：按图书内容 SHA-256 保存的智读问答；由用户明确开启。
- `secret_bundle_v1`：客户端加密后的 API Key/翻译凭据包；由用户设置同步密码后明确开启。

## 账户找回与私密密钥包

- 登录密码只能通过账户已验证的绑定邮箱重置；服务端保存密码哈希与一次性令牌摘要，不保存明文密码或验证码。
- `secret_bundle_v1/default` 的 JSON 是端到端加密信封。信封必须含 `epoch`，其值必须等于服务端 `/sync/secret-state` 返回的 `secretBundleEpoch`。
- 用户遗忘同步密码时，客户端调用 `/sync/secret-state/reset`。服务端递增世代、写入旧密钥包墓碑；任何旧 `epoch` 的上传必须以服务端墓碑冲突返回，避免离线旧设备复活旧密文。
- 同步密码不可找回；仍持有本机 API Key 的设备可用新密码重新加密并上传当前世代包。

`entities.schema.json` 是契约抽取时的结构底座，不代表已替代服务端运行时校验。任何收紧字段要求的修改都要先验证旧客户端兼容性。
