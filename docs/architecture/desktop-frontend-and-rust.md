# 桌面前端与 Rust 长期架构

## 状态

本方向由 ADR-0025 确认。v1.16.0 已完成桌面业务页面的 React + TypeScript + Vite 替换；它服务于长期大规模维护，并保留独立阅读引擎的性能边界。

## 技术边界

| 范围 | 长期选择 | 说明 |
| --- | --- | --- |
| 新增桌面业务 UI | React + TypeScript + Vite | 适用于书架、设置、同步、账户、统计、资讯等普通业务界面。 |
| 阅读引擎及相邻 Web 层 | JavaScript 与 TypeScript 共存 | 阅读高频路径按明确边界演进；禁止仅为后缀而全量改写。 |
| 阅读引擎 | 命令式 TypeScript/DOM/Canvas | EPUB/PDF、分页、选区、手势与高频渲染保持独立，不由 React 接管。 |
| 桌面原生层 | Rust + Tauri 2 | 窗口、原生菜单、文件、数据库、同步、系统集成和高耗时任务留在 Rust。 |
| 新建独立 Rust HTTP 服务 | Axum + Tokio（需要时） | 仅适用于新服务；现有服务不因技术统一而重写。 |

Tauri 是桌面端 Rust 框架。桌面端不采用 Leptos、Yew、Dioxus 等第二套 Rust UI 渲染框架：它们会与 React Web UI 重叠，增加两份组件体系和迁移成本。

## 前端分层

新模块按下列依赖方向组织；业务 UI 不直接触碰系统 API 或 SQLite 细节：

```text
React 页面/组件
        ↓
feature use cases（业务操作、状态与权限）
        ↓
tauri-api（唯一允许调用 Tauri invoke / event 的前端适配层）
        ↓
Rust commands / domain / storage / sync
```

- `contracts/` 仍是跨端数据和 API 语义的唯一事实来源。前端类型不得自行改写协议含义。
- 全局状态只存跨页面/跨组件的 UI 状态；服务端或 Tauri 异步数据有独立缓存层；单组件状态留在组件内部。
- 复杂、可枚举的流程（同步、导入、账户恢复、阅读器外壳）采用显式状态机或 reducer，不以分散布尔值表达。
- CSS 继续使用设计变量和模块边界。既有全局样式不强行重写；新 React 功能使用 CSS Modules 或等价的局部样式方案。
- 禁止业务组件直接使用 `window.__TAURI__`、散落的 `window.ReaderXxx` 全局对象，或跨功能目录修改 DOM。

## 推荐目录演进

目录是目标边界，不是立即移动现有文件的要求：

```text
apps/
  desktop-ui/            # React 页面入口和窗口入口
packages/
  ui/                    # 可复用视觉组件、设计变量、图标
  domain/                # 纯 TypeScript 业务模型和规则
  tauri-api/             # 类型化 invoke/event 适配层
  reader-engine/         # EPUB/PDF、分页、选区、手势
  contracts-ts/          # 从 contracts 衍生的类型和运行时校验
  test-utils/            # 测试夹具和模拟器
```

既有 `ui/` 继续承载阅读引擎与相邻边界；业务页面已迁入 `apps/desktop-ui/`。后续按模块演进，不为了目录美观做大规模移动。

## 工程门禁

前端进入 TypeScript 后必须有真实覆盖源码的严格类型检查，而不是只检查声明文件。新增模块至少满足：

1. `strict` TypeScript；
2. 格式化与 lint；
3. 单元测试；
4. 涉及 Tauri 交互的集成/端到端验收；
5. Rust command 的输入、输出和错误映射有类型化包装。

Rust 侧继续以小模块和明确层次组织。新增异步任务使用 Tokio；新增错误边界采用可结构化、可测试的错误类型；日志逐步统一到结构化记录，但不得把私密资料写进日志。

## 后续演进

1. 保持 TypeScript 构建、类型检查、lint 与测试门禁；
2. 保持 `tauri-api` 和 contracts 的类型边界；
3. 新增桌面业务 UI 继续使用 React + TypeScript；
4. 阅读引擎只在有明确收益和回归测试覆盖时演进；
5. 回归通过修复或 Git 提交回滚处理，不在产品内保留两套业务页面。
