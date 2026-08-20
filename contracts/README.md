# 鲲鹏阅读器跨端契约

账号与认证流程见 `auth/`（邮箱注册、[手机验证码注册](auth/phone-registration-v1.md)、密码找回及[邮箱绑定/换绑](auth/email-binding-v1.md)）；同步实体与同步 API 见 `sync/`。认证请求/响应 JSON Schema 见 `auth/` 内对应文件。

本目录是同步数据与跨端行为的唯一事实来源，不是某个客户端的数据库导出。

```text
contracts/
├─ sync/             实体、请求与响应的 schema/说明
├─ migration/         离线核心同步状态迁移包的 schema/说明
├─ feedback/         用户主动提交反馈的请求/响应约束
├─ fixtures/         稳定的测试数据样本
└─ compatibility/    各端必须通过的兼容性断言
```

## 使用方式

1. 修改阅读进度、高亮、批注、标签、书单、统计、删除或同步 API 前，先更新本目录。
2. 不兼容变更必须升级 `syncProtocolVersion`，同时提供迁移与回滚说明。
3. fixture 中只能使用虚构账号、虚构设备、虚构书籍与脱敏文本；不得放 Token、真实邮箱、路径、真实阅读内容或 API Key。
4. 当前文件是“抽取阶段”骨架；在其成为 CI 强制门之前，必须与 Rust 服务
   `server/reader-sync-api-rs` 和桌面现有行为逐项核对。
5. 迁移包不是恢复点或 SQLite 导出；其格式、限制和明确排除项见 `migration/` 与 ADR-0010。
