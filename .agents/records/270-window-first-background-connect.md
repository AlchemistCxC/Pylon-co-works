# Dev Record — #270 窗口先见：默认 agent ACP 连接后台化

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。决策依据见 ADR-0022。

## 元信息

- issue：#270
- 分支：`kumo/prometheus`（堆叠 PR #268）
- 提交范围：`b1d68929..`（本条）
- 日期：2026-09-24

## 目标与范围

窗口出现时间与默认 agent 的 CLI 启动/握手解耦（#269 基线：连接 2004ms 托底窗口至 2021ms）。用户裁定语义：窗口先见 + 后台连接；**连接期间禁止发送**（不做排队/自动触发）；左上角 agent status 同步展示连接中状态。

**不做什么**：不动 switch/reconnect/gateway 懒启动语义；不动前端状态灯与归一化（映射现成）；不做发送排队。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/lib.rs` | `run()`：删窗口前阻塞连接块，runtime 置 `Connecting`；`run_setup_pipeline`：后台连接 spawn（`connect_and_replace` 全激活机器，双锁同序）+ dispatcher 启动跳过 Connecting runtime + `default_agent_connect_started/settled` 相位迁移 | 修改 |
| `src-tauri/src/agent/runtime.rs` | `AgentLifecycleStatus::Error` 变体 `#[allow(dead_code)]` + 保留理由注释（失去唯一生产构造点后的 wire/harness 保留） | 修改（一行属性） |
| `src/sheets/agent-workbench/agentWorkbenchCommands.ts` | `send` 顶部 connecting 门控（明确提示，不触达后端） | 修改 |
| `src/sheets/agent-workbench/__tests__/agentWorkbenchCommands.test.ts` | +2 用例（connecting 阻断 / connected 不受影响） | 修改 |
| `.agents/decisions/0022-*.md`、`docs/说明书/Pylon-项目架构参考.md`（§6） | 决策与说明书同步（顺带修正 §6「异步 activate」→ 实际串行 await 的措辞漂移） | 新增/修改 |

## 方案要点

- **复用完整激活机器**：后台任务走 `AppState::connect_and_replace`（= `do_connect_and_replace`，`start_status=Connecting`、`continuity=Invalidated`、`announce=true`）——generation/epoch 校验、实例预算、dispatcher 重启、probe 收敛、announce 全部继承，不重造轮子（模板：`restart_agent_runtime` 同构调用）。
- **竞争窗口串行化**：任务持 `switch_lock → agent_lifecycle` 双锁（与 switch/reconnect 同序），连接期约 2s 内的手动 switch/reconnect 排队而非交叉；epoch 校验兜底旧代际覆盖。
- **失败语义微调**（记录为有意偏离）：启动连接失败旧路径置 `Error`；新路径经 `status_after_connection_failure(Connecting)` 回落 `Disconnected`，announce 载荷携带 lastError/recentError/error 别名——红灯呈现与手动 reconnect 可达性不变。`Error` 变体由此失去生产构造点，按 wire 词汇保留并注记。
- **dispatcher 时序**：setup 期对 Connecting runtime 不启动 dispatcher（占位 client 上启动无意义且可能误报崩溃）；激活路径内 `replace_agent_client` 自会启动。
- 前端快照/监听契约不破坏：`agent_status` 快照读到 Connecting → 监听注册后收到 Connected/失败事件；恢复路径既有 `waitForAgentReady`（15s）覆盖连接窗口。
- 发送门控在命令装配层（`send` 读 `useRuntimeStore`），bootstrapApplication 纯函数零污染；后端发送失败路径保持兜底。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 实机：窗口创建不再被连接托底 | ✅ `windows_created=43ms`（基线 2021ms，提前 ~2s）；连接后台 `started=308ms`、`settled=2829ms`（tracing 相位） |
| 状态灯中间态 | ✅ 重连触发实测三灯 `cascade → steady×13 → cascade`（黄=连接中，既有映射零改动） |
| connecting 期发送阻断 + 提示 | ✅ 单测 2 例（阻断且不触达后端 / connected 不受影响） |
| 启动行为契约 | ✅ 「Agent startup-connect started/succeeded」日志可见；agent-status 事件广播 |
| 既有门禁 | ✅ cargo lib 809 绿；clippy 零新增（现存 6 条均在既有文件）；vitest 全量见 issue 回写；eslint 0；tsc 零错误（#267 修复后 build 链已解封） |

## 测试处置

新增：`agentWorkbenchCommands.test.ts` 2 用例。修改既有行为测试：**无**。

## 证据

- commit：本条
- 实机（真实 agents.yaml，Hermes/riccati）：`windows_created=43 / setup_enter=295 / setup_complete=308`；前端 `ready=477`；日志 `Agent startup-connect started → succeeded`；重连期间三灯 steady（黄）→ 恢复 cascade（绿）
- 门禁输出：见 issue #270 回写

## 与 spec 的偏差

- `Error` 变体保留注记（runtime.rs 一行属性）为 spec 外必要跟进，已在 L.md 域外追加声明。
- 失败语义 Error→Disconnected 微调已在上文「失败语义微调」说明，ADR-0022「后果」节已预载。

## 未解问题

1. release profile 的前后对照数字（#269 记录未解问题 1 同源）留待发行前采集；本批实机为 debug profile，同构建形态下前后对照已成立。
2. 连接期窗口内「发送入口禁用（按钮 disabled）」形态 vs 现行「提交时明确提示」：已按后者落地（用户裁定允许二选一）；若后续要按钮态，可在 InputBar 读同一 store。

## 并行交集

- `src-tauri/src/lib.rs`（#269 同文件，其条目已收口）；`src-tauri/src/agent/runtime.rs` 域外一行已在 L.md 补声明。
- 共享树期间 #267/#272 会话在渲染器/CSS 域并行施工（MarkdownContent/ChatView.css），本批零交集；全程 pathspec。
