# Dev Record — #421 生产 connect 总时间预算（60s TotalDeadline）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#421（#417 裁决第 2 项；批复：默认 60s 总预算，超时按既有 Crashed 收敛，不新状态）
- 分支：`kumo/421-connect-budget`（复用 worktree `G:/Project/prism-team-workdir/pylon-424`，checkout 自 github/main `9229f564`；共享树 CSS/tsx 脏文件与 main 进站改动重叠，沿 #424 先例）
- 提交范围：`9229f564..HEAD`
- 日期：2026-09-28

## 目标与范围

**达成**（issue 期望行为原文）：
1. 生产 connect 加 `TotalDeadline` 总预算，默认 60s，常量落 `lifecycle/budgets.rs`。
2. 超时按既有 Crashed 收敛路径处理（复用 crash_reconnect 机制），不发明新 runtime 状态。
3. 架构参考 §12 invariant 补「生产 connect」并移除 #417 缺口标注。

**不做的**：rpc_timeout 语义不动；自动重连 ReconnectPolicy/crash_reconnect 循环逻辑不动（超时 Err 天然落入其既有 Err 分支）；预算不可配（固定常量，与 AGENT_VALIDATION_TIMEOUT_SECS 同列）；不碰 `pylon-acp/**`；不碰前端；不为「连接从未完成的 agent」复刻 pet 反应/自动重连触发（crash 通道属已连接 agent 的 dispatcher，新 agent 无挂载点——已在 issue 评论声明，若需另立 issue）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/lifecycle/budgets.rs` | +`CONNECT_TOTAL_BUDGET_SECS = 60`（表行 + TotalDeadline 形状标注）；+`connect_budget_secs()` 解析口；+`connect_budget_override` cfg(test) 注入缝 | 新增 |
| `src-tauri/src/lifecycle/mod.rs` | `do_connect_and_replace`：`connect_with_generation` 包 `tokio::time::timeout`（本体留 mod.rs——维护地图 :67 红线）；超时分支 → Crashed 收敛 + 稳定码 `connect_budget_exceeded` 日志 + Err；函数文档 +1 行；tests +1 条 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | §12 invariant 行（:389）补「生产 connect」、移除 #417 缺口标注 | 修改 |

## 方案要点

1. **单点包裹**：四条生产 connect 路径（switch :273 / reconnect 包装 / restart :347 / 自动重连 crash_reconnect.rs:215 + 平台懒启动）全部经 `do_connect_and_replace`，预算包在 `AcpClient::connect_with_generation` 外层即覆盖全部。
2. **超时取消安全性**：timeout 掉 connect future → 局部 `ManagedChild` drop → `kill_and_wait`（Job Object / taskkill /T 兜底）杀整棵进程树——与既有错误路径同语义，不泄漏（本轮两轮 350s+ 实验后 tasklist 证实无遗留进程）。
3. **Crashed 收敛 = 状态 + 既有消费方照旧**：超时分支 `emit_agent_status(Crashed)`（经 `set_agent_runtime_status` 落地 runtime state）+ lastError + AGENT_STATUS 事件 + runtime-log 稳定码；不发明新状态。调用方语义零改动：自动重连的 Err 分支退避重试（机制复用，status 保持 Crashed 使 still_stale 复查成立），手动操作在预算处释放双锁。
4. **测试注入缝弃用模拟时钟**：先试 `#[tokio::test(start_paused = true)]`——实测引擎超时面混布 tokio 定时器与 std 线程，暂停时钟下预算定时器不触发（351s 后由引擎真实错误收场）；改为 `budgets::connect_budget_override`（cfg(test) AtomicU64，set/Drop-clear 成对，单测试消费无并行竞争面），2s 真预算 + 真 hang 子进程驱动完整路径。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| hang agent 被预算切断、Err 含标记、status 收敛 Crashed、lastError 落地 | ✅ `connect_total_budget_cuts_hung_agent_and_converges_to_crashed` 绿（2.03s：判别证据——进入时前一状态 Disconnected，普通错误会回落 Disconnected，终态 Crashed 只能来自预算分支） |
| 常量 pin 60 + 形状 TotalDeadline | ✅ 测试内 pin + budgets.rs 表行 |
| 既有测试零修改 | ✅ diff 无测试改动（934 = 原 933 + 1 新增） |
| 门禁 | ✅ `cargo test -p pylon --lib` 934/0；`cargo test --workspace --lib` 9 目标 1592/0；`bun run check:clippy` exit 0（基线外零新增）；`cargo fmt --all --check` 净 |
| 架构参考 §12 行 | ✅ 含「生产 connect」、#417 标注已移除 |

## 测试处置

- 新增：`lifecycle::tests::connect_total_budget_cuts_hung_agent_and_converges_to_crashed`。
- 修改/删除既有行为测试：无。

## 证据

- commit：`fix(#421)`（分支 `kumo/421-connect-budget`，基准 `9229f564`）
- 测试（exit 0）：lifecycle 模块 30/0（含新增）；`-p pylon --lib` 934/0（4 ignored 既有）；workspace `--lib` 9 目标 1592/0；clippy 基线外零新增；fmt 净。
- 前置：`cargo build -p pylon-fake-agent --features test-agent`（hang 场景 spawn 依赖）。
- 手工验证：未走实机验收（后端行为变更，无 UI/几何面；预算路径由真子进程测试钉死）。

## 与 spec 的偏差

- spec 初稿测试方案为 `start_paused` 模拟时钟；实测不可用（方案要点 4），改为测试注入缝——spec 已同步改写，此节留档。

## 未解问题

- switch 超时后是否需要自动重试（本批不做：crash_reconnect 通道属已连接 agent 的 dispatcher，从未完成连接的 agent 无挂载点）——若仓库主认为需要，另立 issue。
- 预算值固定 60s 不可配——裁决既定；若未来 rpc_timeout 常配 >60s 的场景出现，需重审「预算盖过 rpc_timeout」的取值关系。

## 并行交集

- 共享树：仅 `.agents/L.md`（03fbe0e9 声明 + 收尾条目）与 `.agents/spec/421-*.md`（不入库）。
- worktree 域：`src-tauri/src/lifecycle/{mod,budgets}.rs`、`docs/说明书/Pylon-项目架构参考.md`。无他人声明域重叠（#423 域为 permission/private_interaction，未触）。
