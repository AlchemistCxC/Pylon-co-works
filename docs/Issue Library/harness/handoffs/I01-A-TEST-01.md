# Handoff: I01-A-TEST-01

- 角色/模式：开阳（S）/ `longrun-a`
- 类型：TEST；依赖：I01-A-BE-01（已合 main）、I01-A-FE-01（已合 main）
- Base commit：`531357d`（main，含依赖合并与 Harness 全量入库）
- 证据等级：**L3**（三链路真实 ACP wire）+ L1（test/lint/build）
- 状态：`review_pending`，本卡证据文档交付；done 由人工（宫木云）验收

## 目标与验收

- objective：Release 三链路真实证据采集
- AC-1：记录 **Agent ready、ACP prompt response、assistant content** 三链路真实证据，三者不以状态灯替代（任务卡 yaml `acceptance[0]`，address `docs/Issue Library/ISSUE-01.md`）

## 验证命令执行结果（task yaml commands.focused / broader，逐条真实输出）

| 命令 | 结果 | 证据等级 | 真实输出摘录 |
|---|---|---|---|
| `npm run test`（focused） | 通过 | L1 | 45 files，213 passed（连续两次 45/213；首次运行 8 个 vitest worker-fork 池错误致只收 37 files/185 tests，为测试池并发抖动，非用例失败，重跑恢复全量） |
| `npm run lint` | 通过 | L1 | `eslint src/` 退出 0，无报错 |
| `npm run build` | 通过 | L1 | `tsc -b && vite build` ✓ built in 8.46s，3500+ modules |
| `git diff --check` | 通过 | L1 | 退出 0，无 whitespace error |
| `python docs/Issue Library/harness/scripts/validate_harness.py` | 通过 | L1 | Harness 校验通过：45 张任务卡，依赖 DAG 无环 |
| `cargo test --lib`（Rust 全量） | 通过 | L1 | 425 passed; 0 failed; 4 ignored; 0 filtered out，10.31s |
| `cargo test --lib real_acp -- --ignored --nocapture`（L3 真实 agent 门禁） | 通过 | L3 | 4 passed; 0 failed; 18.47s（见下三链路） |

## 三链路真实证据（AC-1，L3）

三链路证据来自**真实 ACP agent 进程**（subprocess transport）：

1. `agents.yaml` 生效配置 default agent = **Peri**（`default: true`，命令 `peri.exe acp --model deepseek-v4-flash`，二进制路径见生效 `agents.yaml`）；
2. **Hermes**（`hermes acp`，`hermes_profile: riccati` → 注入 `HERMES_HOME=<riccati profile 目录，由 agents.yaml 指定>`，deepseek provider + opencode.ai base_url）。

### 链路 1：Agent ready（真实 initialize 握手）

`real_acp_smoke::real_agent_initialize_new_session_and_process_cleanup` 真实连接 default agent，`AcpClient::connect_with_logs` 完成 `initialize` 后持有真实子进程 pid，`session/new` 成功，`kill` 后直接子进程被回收（`tasklist` 复核不存在）。真实 wire：

- Hermes `initialize` 响应（探针全量打印）：`{"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true},...},"agentInfo":{"name":"hermes-agent","version":"0.20.0"},"authMethods":[...],"protocolVersion":1}`
- Peri `initialize` 响应：`{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{...},"sessionCapabilities":{"list":{},"fork":{},"resume":{},"close":{}},"auth":{},...},"authMethods":[]}`

### 链路 2：ACP prompt response（session/new + session/prompt 真实往返）

- 真实 `sessionId`（非 mock）：
  - Peri：`019fe7e9-a637-7701-a03c-9df1d0641656`
  - Hermes：`d42f62cb-c637-4037-b277-09a40552ba93`
- `session/prompt` 终态响应（真实 JSON-RPC result）：
  - Hermes：`{"stopReason":"end_turn","usage":{"cachedReadTokens":3840,"inputTokens":17698,"outputTokens":16,"thoughtTokens":14,"totalTokens":17714}}`（真实 token 消耗证明模型调用发生）
  - Peri：`{"stopReason":"end_turn"}`（本次环境 usage 0，见"阻塞与失败证据"）
- `real_agent_prompt_round_trip` 断言 `PromptWaitOutcome::Response` 且 `prompt_stop_reason` 合法，通过。

### 链路 3：assistant content（真实流式内容，非状态灯）

Hermes（riccati profile）prompt `"请只回复两个字：收到"` 后，`session/update` 通知流式吐出真实 assistant 文本（探针逐块捕获，截选）：

```
CHAIN3_ASSISTANT_STREAM: 用户
CHAIN3_ASSISTANT_STREAM: 要求
CHAIN3_ASSISTANT_STREAM: 只
CHAIN3_ASSISTANT_STREAM: 回复
CHAIN3_ASSISTANT_STREAM: 两个字
CHAIN3_ASSISTANT_STREAM: "
CHAIN3_ASSISTANT_STREAM: 收到
CHAIN3_ASSISTANT_STREAM: "
CHAIN3_ASSISTANT_STREAM: 。
...
CHAIN3_ASSISTANT_STREAM: 收到
```

即 assistant 最终回答内容为「收到」——**真实模型产出**，与前端 `session/update → update.content.text` 消费路径（`dispatcher/mod.rs` handle_session_update）一致。链路证据：探针（scripts 外临时脚本）在仓库根目录以 HERMES_HOME 注入 riccati profile 运行，wire 原文留存于本次运行日志。

### 反证（不以状态灯冒充）

- 直接以系统 active_profile（l-m，provider 无效）跑 `hermes acp`，prompt 流式内容为 `HTTP 401: Invalid API key.` —— 说明**仅有连接状态灯不代表内容链路可用**；本卡内容链路证据必须采自 `hermes_profile` 注入的 riccati profile（与 `hermes_configured_profile_real_prompt_round_trip` 同一路径）。
- `hermes_connect_idle_no_false_crash`：connect 后 idle 5s 无假崩溃（stdout 存活），通过。

## 工作区

- 本卡仅新增证据文档 `docs/Issue Library/harness/handoffs/I01-A-TEST-01.md`（handoffs 目录为重建）。
- 领取前工作区存在批量未提交删除：`docs/Issue Library/HARNESS.md`、`INDEX.md`、`harness/*.md`、`harness/handoffs/*.md`、`harness/templates/*`、`harness/manifest.yaml`、`multica/*`、`未决策项.md`（git 显示 ` D`，未 staged）。**不属于本卡 scope，未恢复、未纳入提交**；如需回滚请另行处理。
- 执行期间发现 `src-tauri/Cargo.toml` / `Cargo.lock` 被并发修改（新增 `rusqlite 0.40.2 bundled`，时间戳 02:39-02:40，疑似 I06-A-DATA-01 并行工作）。**不在本卡 scope.allow，未触碰、未纳入提交**；`cargo check/test` 均能编译通过（rusqlite 当前未被 src 引用，不影响本卡验证结果）。

## 阻塞与失败证据

- **Peri content 链路本环境未产出**：Peri prompt 终态 `end_turn` 但 usage 为 0（0 input / 0 output tokens），探针未捕获到 assistant 流式文本——判断 Peri 在本机的模型凭据/网络未就绪（或模型调用静默未发）。这不推翻 Peri 的 Agent ready 与 ACP prompt response 两链路（wire 均真实成立），且 `real_agent_prompt_round_trip` 对 default agent 断言通过；但**Peri 的 assistant content 第三链在本环境无真实内容**，如实记录，未以任何状态灯或伪造内容代替。Hermes（riccati）三链均完整。
- 首次 `npm run test` 出现 vitest `[vitest-pool]: Worker forks emitted error` / `Worker exited unexpectedly` 8 个错误、只收 37 files；属测试 worker 池并发抖动（无用例失败输出），连续两次重跑均 45 files / 213 passed 全绿。已在表中如实记录。

## 下一条确定动作

1. 玉衡审查本 handoff 与证据文档；通过后由天璇/天权合并到 main。
2. 建议人工在打包环境复跑 `cargo test --lib real_acp -- --ignored --nocapture` 留存最终 L3 快照；Peri content 链路需在 Peri 凭据有效的机器上补证（可选）。
3. 工作区批量删除与 rusqlite 并发修改请队长确认归属，避免后续卡片误并入提交。

## 不得假定

- 本卡只采集证据，不改任何 src 代码；L3 仅覆盖已实测的 Peri/Hermes 两 agent 的 wire 链路，不代表所有 agent/模型环境。
- `end_turn` + 0 usage 的 Peri 往返不构成"assistant content 链路通过"的证据；三链均须以真实 wire 内容为准。
