# 情报中心本机 8B 判定模型

情报中心的小模型使用 Qwen 官方发布的 `Qwen3-8B-Q4_K_M.gguf`。它只负责逐篇重要性初筛及八类文章关系分类（精确重复、转载、同一事件、事件进展、同一系列、背景、纠错、不相关）；Qwen3 Embedding/Reranker 负责全量召回和重排，Qwen 27B 负责分层抽检和最终综合报道。

## 固定模型与完整性

- 发布者：`Qwen`
- 仓库：<https://huggingface.co/Qwen/Qwen3-8B-GGUF>
- 固定 revision：`212c964b8f97cb5edc203d411b767aaae707e653`
- 文件：`Qwen3-8B-Q4_K_M.gguf`
- 大小：`5,027,783,488` 字节
- SHA-256：`D98CDCBD03E17CE47681435B5150E34C1417F50B5C0019DD560E4882C5745785`
- 许可证：Apache-2.0

模型、运行时、日志、PID 和基准报告都保存在 `%LOCALAPPDATA%\kunpeng-reader\local-llm\`，不进入仓库、同步、备份或发布物。

本轮验证使用 llama.cpp `build 10549`（commit `b2e5e9b28`）Windows x86_64 运行时；`llama-server.exe` SHA-256 为 `C8B1E5A66E1BB45854BED3DAAAB116C37E74526E30143D737C67557BAB822359`。该构建原生提供 `/v1/embeddings` 与 `/v1/rerank`，无需额外 Python 常驻服务。

## 安装与运行

```powershell
# 从固定的 Qwen 官方 revision 下载，并按大小和 SHA-256 校验
.\scripts\local-intelligence-judge.ps1 -Action Install

# 推荐的积压处理模式：按需独占 GPU；不得与 27B 或 8B Embedding 同时加载
.\scripts\local-intelligence-judge.ps1 -Action StartGpu

# 仅作故障回退的 CPU 模式；实测吞吐不足以承担全量回填
.\scripts\local-intelligence-judge.ps1 -Action StartCpu

# 状态、健康检查和固定中英文关系样本基准
.\scripts\local-intelligence-judge.ps1 -Action Status
.\scripts\local-intelligence-judge.ps1 -Action Health
.\scripts\local-intelligence-judge.ps1 -Action Benchmark

# 只停止 PID 文件记录且命令行、模型路径、端口均匹配的进程
.\scripts\local-intelligence-judge.ps1 -Action Stop
```

服务固定监听 `127.0.0.1:8081`，OpenAI 兼容地址为 `http://127.0.0.1:8081/v1`，模型名为 `Qwen3-8B-Q4_K_M`。上下文默认 8192 token，关闭思考输出，并用 JSON Schema 约束分类结果。所有服务将 CORS 限制为 localhost 且关闭跨域凭据；产品应从 Rust 后端调用，不能由任意网页直接调用。

## 自动阶段切换

RTX 5070 Ti 16 GiB 不同时常驻 8B 判定模型和 27B 编辑模型。应用通过固定、无任意命令参数的原生入口调用 `local-intelligence-runtime.ps1`，以持久化断点完成两阶段交接：

1. `TriageGpu`：0.6B Embedding/Reranker 在 CPU 常驻，8B Embedding 在 CPU 只校准低置信边界，Qwen3-8B 在 GPU 逐篇初筛并判定八类关系；
2. 全部 8B 结果先写入 SQLite，随后停止 8B Embedding 和 8B 判定服务；
3. `EditorialGpu`：启动 Qwen3.8-27B Q3 + MTP，在 GPU 上做分层抽检、全文证据归并和最终综合报道；
4. 下一批确有新增/指纹变化的资讯到来时再切回 `TriageGpu`。缓存命中的事件不触发任何模型切换、网页抓取或重复生成。

```powershell
.\scripts\local-intelligence-runtime.ps1 -Action TriageGpu
.\scripts\local-intelligence-runtime.ps1 -Action EditorialGpu
.\scripts\local-intelligence-runtime.ps1 -Action Status
```

切换使用全局/服务级命名锁，先完成固定 revision、大小、SHA-256、端口所有权预检，再停止旧阶段；新阶段健康检查或模型别名校验失败时恢复旧阶段。所有监听只允许 `127.0.0.1`，脚本只停止状态文件、可执行路径、模型路径和端口都匹配的本机进程。

真实往返验收中，`TriageGpu → EditorialGpu → TriageGpu` 均建立了预期阶段；27B 的 `/v1/chat/completions` JSON 冒烟为 `66.83 token/s`，日志确认创建 MTP draft context。两个 0.6B 服务在切换期间保持健康，8084 只在初筛阶段运行，8080 与 8081 从不同时监听。

## GPU 积压模式

首次回填或积压量很大时，可让 8B 全层进入 RTX GPU：

```powershell
.\scripts\local-intelligence-judge.ps1 -Action Stop
# 先通过 27B 自己的控制入口停止 27B；不要按进程名批量结束。
.\scripts\local-intelligence-judge.ps1 -Action StartGpu
.\scripts\local-intelligence-judge.ps1 -Action Benchmark
```

`StartGpu` 会检查所有显式使用 CUDA 的 `llama-server`，并额外识别已知 Qwen 27B 命令行；发现冲突时只拒绝启动，不会替用户停止进程。GPU 回填结束后应停止 8B GPU 服务并恢复 27B；只有 GPU 暂时不可用且任务量很小时才启用 `StartCpu` 回退。

CPU 与 GPU 模式都只使用一个服务槽，启用连续批处理并关闭 Web UI。GPU 使用 Q8 K/V cache；CPU 在关闭 Flash Attention 时使用 Q8 K 与 F16 V cache，以满足 llama.cpp 的运行约束。脚本发现 `8081` 被未跟踪进程占用时会拒绝替换，避免影响用户的其他本机服务。

## 验收边界

`Benchmark` 使用不含私密数据的固定中英文公开场景，报告：

- JSON 合规率；
- 八类关系的基础匹配率；
- 平均与 P95 请求时延；
- 模型生成 token/s；
- 进程内存和可获得时的进程显存。

这只是运行时和基础分类冒烟，不能代替真实新闻集上的重要新闻召回率、错误合并率和 Qwen 27B 分层抽检。生产流水线应把模型 SHA、提示词版本和正文指纹一起放入缓存键；任一项改变都必须重新判定。

RTX 5070 Ti（16 GiB）上的固定八类样本最终回归：GPU 生成约 `78.64 token/s`，平均 `0.865 s/对`、P95 `1.049 s/对`，GPU 总显存相对停服基线增加约 `5,369 MiB`（`5.24 GiB`）；CPU 仅约 `9.84 token/s`，平均 `7.16 s/对`，进程工作集约 `8.95 GiB`。两种模式 JSON 合规率均为 100%，八类基础关系命中 7/8。模型会把内容相同但来源独立的中英报道误判为 `exact_duplicate`，因此流水线必须执行硬护栏：`exact_duplicate` 只有在前置正文哈希、规范 URL 或转载证据成立时才可接受，否则降级为 `same_event`/低置信并交给 Qwen 27B 抽检。

## 本机新闻检索模型

| 角色 | 模型与量化 | 端口 | 运行方式 |
| --- | --- | ---: | --- |
| 全量中英召回 | Qwen3-Embedding-0.6B Q8_0 | 8082 | CPU 常驻，1024 维 |
| 候选重排 | Qwen3-Reranker-0.6B Q8_0 | 8083 | CPU 常驻，`/v1/rerank` |
| 低置信校准 | Qwen3-Embedding-8B Q4_K_M | 8084 | 按需顺序加载，4096 维 |

固定产物：

- `Qwen/Qwen3-Embedding-0.6B-GGUF` revision `370f27d7550e0def9b39c1f16d3fbaa13aa67728`，`639,150,592` 字节，SHA-256 `06507C7B42688469C4E7298B0A1E16DEFF06CAF291CF0A5B278C308249C3E439`，Apache-2.0；
- `ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF` revision `a02f48bb4f057028298c21fa033da2b30d7742d5`，`639,153,184` 字节，SHA-256 `22C9979CE4FBCDC5ACDC310C6641C32797EFF1AA980B8F7A2DB8A8EA23429A48`，Apache-2.0。该 GGUF 由 llama.cpp 组织从官方 `Qwen/Qwen3-Reranker-0.6B` 转换；
- `Qwen/Qwen3-Embedding-8B-GGUF` revision `69d0e58a13e463cd99a9b83e3f5fee7c10265fab`，Q4_K_M 为 `4,676,804,928` 字节，SHA-256 `3FCD3FEBEC8B3FD64435204DB75BF0DD73B91E8D0661E0331ACFE7E7C3120B85`，Apache-2.0。

```powershell
# 安装并启动两个 0.6B CPU 常驻服务
.\scripts\local-intelligence-retrieval-models.ps1 -Action InstallCore
.\scripts\local-intelligence-retrieval-models.ps1 -Action StartCore
.\scripts\local-intelligence-retrieval-models.ps1 -Action Smoke

# 两个服务也可独立启停和检查，便于故障隔离
.\scripts\local-intelligence-retrieval-models.ps1 -Action StartEmbeddingCpu
.\scripts\local-intelligence-retrieval-models.ps1 -Action HealthEmbedding
.\scripts\local-intelligence-retrieval-models.ps1 -Action StopEmbedding
.\scripts\local-intelligence-retrieval-models.ps1 -Action StartRerankerCpu
.\scripts\local-intelligence-retrieval-models.ps1 -Action HealthReranker
.\scripts\local-intelligence-retrieval-models.ps1 -Action StopReranker

# 8B 高精度向量只在低置信校准队列中按需加载
.\scripts\local-intelligence-retrieval-models.ps1 -Action InstallCalibration
.\scripts\local-intelligence-retrieval-models.ps1 -Action StartCalibrationGpu
.\scripts\local-intelligence-retrieval-models.ps1 -Action Smoke
.\scripts\local-intelligence-retrieval-models.ps1 -Action StopCalibration
```

`StartCalibrationGpu` 必须与 8B 判定模型和 27B 综合模型顺序运行；无可用 GPU 时可以改用 `StartCalibrationCpu`，但只适合作为低吞吐故障回退。

Embedding 使用 Qwen 官方要求的 `last` pooling，并通过 OpenAI 兼容 `/v1/embeddings` 输出向量。Reranker 使用 `rank` pooling，通过 `/v1/rerank` 重排。两个 0.6B 常驻服务使用 4096 token 上下文、1024 batch；流水线必须先对长正文分块。8B 校准服务保留 8192 token 上下文。`Smoke` 验证 1024/4096 维度和中英文候选第一名。

Qwen3 Embedding 的查询向量应按官方格式附带任务指令，文档向量不加指令。例如：`Instruct: Given a news report, retrieve cross-language reports about the same event or continuing series.\nQuery: <标题与正文分块>`。索引和在线查询必须固定同一模板版本，并把模板版本写入索引元数据，避免静默改变相似度分布。

本机 CPU 最终冒烟中，0.6B Embedding 对两条中英文本返回 1024 维向量约 `112 ms`；Reranker 对三条候选约 `573 ms`，正确候选排名第一。两个常驻进程工作集合计约 `2,962 MiB`、私有内存合计约 `2,627 MiB`。8B Embedding 全层 GPU 加载时，对两条中英文本返回 4096 维向量约 `79 ms`，进程工作集约 `4,920 MiB`、私有内存约 `6,634 MiB`，GPU 总显存相对停服基线增加约 `6,033 MiB`（`5.89 GiB`）；验证后已停止 8084。

接口返回遵循 llama.cpp 的 OpenAI 兼容形状：

```json
{
  "object": "list",
  "model": "Qwen3-Embedding-0.6B-Q8_0",
  "data": [{ "index": 0, "object": "embedding", "embedding": ["1024 floats"] }],
  "usage": { "prompt_tokens": 9, "total_tokens": 9 }
}
```

```json
{
  "model": "Qwen3-Reranker-0.6B-Q8_0",
  "object": "list",
  "usage": { "prompt_tokens": 272, "total_tokens": 272 },
  "results": [{ "index": 1, "relevance_score": 0.9999 }]
}
```

8B Embedding 也提供 `StartCalibrationGpu`，但脚本发现任意已知 GPU llama-server 或 27B 服务时只拒绝启动，不会自动停止其他模型。两个 0.6B CPU 服务可与 27B 并行；8B 校准服务完成低置信队列后应立即停止。
