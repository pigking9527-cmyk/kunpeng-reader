# ADR-0015：Android 阅读问题记录的进程内闭合轨迹

## 状态

已接受（2026-08-07）。

## 背景

阅读器的手势、章节切换与 WebView 交互问题需要在用户复现后提供最小的本机证据。它不能借“诊断”之名收集正文、选区或身份数据，也不能绕过 ADR-0008 的用户主动附件边界。

## 决定

- Android 阅读器维护独立格式 `kunpeng-reader-android-reader-problem-trace` v1；它不是同步实体、反馈 API 字段或 `kunpeng-reader-core-data-package` 的一部分，不改变 `syncProtocolVersion`。
- 轨迹仅存于当前进程内，保留最近 60 秒且至多 320 条；应用退出自然丢失。不得写 SQLite、metadata、恢复点、日志、缓存或网络请求。
- 每条记录只能使用闭合集合：事件（`ready`、`tap`、`page_boundary`、`chapter_navigation`、选区菜单状态）、结果（`handled`、`blocked`、`started`、`completed`）和受限的方向、点击区域、滚动/分页表示、非负章节序号。导出使用相对冻结时刻的 `ageMs`，不带书籍身份。
- 阅读 WebView 到 Flutter 的 `bug-trace` 消息必须有精确顶层字段与 detail 白名单。未知、缺失、越界或类型错误字段均拒绝整条消息；不可将原始 bridge JSON、异常对象或任意字符串直接记录。
- 严禁采集、导出或传递：正文、选中文字、书名、content ID、章节键、路径、URI、链接、账号、设备/同步标识、API Key、密码、Token、异常原文、HTTP 数据或反馈文本。
- 用户可在阅读工具中查看并“冻结”快照、清空、复制，或经 Android SAF 明确选择位置导出一份 UTF-8 JSON。导出内容按 ADR-0008 的 256 KiB 原始附件上限约束。
- 该记录不得自动附加、提交或上传。若将来用户希望附给 Bug 反馈，仍必须在 ADR-0008 的 Bug 页面明确选择该 JSON；本 ADR 不创建任何自动关联。

## 兼容性与回滚

这是 Android 本端支持材料。删除入口和内存收集器即可回滚，既有数据、同步、恢复点与反馈草稿均无需迁移。

## 验证

1. 321 条或一分钟外的事件不出现在冻结快照；
2. 含选区、路径、ID 或未知字段的 WebView payload 被拒绝；
3. JSON 仅有闭合字段且不超过 256 KiB；
4. 清空只影响当前进程内环；SAF 导出、复制、查看均不会联网或附加反馈。
