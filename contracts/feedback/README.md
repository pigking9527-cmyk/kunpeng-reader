# 用户反馈接口

`request.schema.json` 描述“关于 → 提交 Bug / 功能提议”发送到反馈服务的 JSON 请求。它不是同步协议的一部分，但桌面端与反馈服务必须共同遵守。

JSON 附件规则：

- `attachments` 是向后兼容的可选数组，最多 1 项；
- 仅 `kind=bug` 可携带附件；
- 文件名以 `.json` 结尾，MIME 为 `application/json`；
- `data` 是 Base64；解码后为 1–262144 字节、UTF-8、有效 JSON；
- 成功响应必须包含 `acceptedAttachments`，其值为服务端实际接收的附件数量。客户端提交附件时不得把缺少该确认的响应当作成功。

服务端仍对整个 HTTP 请求执行总大小限制。fixture 必须使用虚构诊断数据，不得包含真实账号、Token、书籍正文或本机路径。
