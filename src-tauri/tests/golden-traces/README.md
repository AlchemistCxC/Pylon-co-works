# ACP golden trace 基线（A0/A9）

本目录是 **P60/A0** 建立、在 A1c 收敛 SDK 后由 A9 重新生成的 ACP wire 时序基线。
当前唯一运行实现是官方 SDK engine；基线用于 A9 的重复运行、协议顺序与资源边界验收。

## 生成与校验

```powershell
node scripts/generate-acp-golden-trace.mjs           # 重新生成 JSONL（保留本 README）
node scripts/generate-acp-golden-trace.mjs --check   # 只校验：两遍运行一致 + 与已提交基线一致
```

生成器本体是 test-only 的 Rust 测试
（`src-tauri/src/acp/golden_trace_tests.rs`，由 `PYLON_GOLDEN_TRACE_DIR` 启用），
脚本负责两次运行的确定性比对与落盘。未设置该环境变量时，该测试是 no-op，
因此常规 `cargo test --lib acp::` 不受影响。

## 场景（10 个：施工书 §A0 步骤 4 的 8 个，加 P71/A5① 的两个 wrapper 场景）

| 文件 | 场景 |
| --- | --- |
| `initialize.jsonl` | 握手 |
| `new_load.jsonl` | `session/new` + `session/load`（含 replay 通知） |
| `prompt.jsonl` | prompt + 流式 chunk + 终态响应 |
| `tool.jsonl` | tool_call / tool_call_update |
| `permission.jsonl` | `session/request_permission` + 客户端应答 |
| `done_error.jsonl` | prompt 错误响应路径 |
| `cancel.jsonl` | `session/cancel` + `stopReason=cancelled` |
| `reconnect.jsonl` | 两代连接（generation 1 → 2）+ 重连后 `session/load` |
| `wrapper_claude.jsonl` | **P71/A5①**：`provider=claude-code` 的 initialize + new + prompt；锁定 catalog 声明的 `clientCapabilities` 真实上线（`_meta.subagent-transcript` + 嵌套 `jetbrains.air` 叠在 Pylon 默认之上） |
| `wrapper_codex.jsonl` | **P71/A5①**：`provider=codex` 的同一条路径；该 provider 不声明 caps，因此只带默认 `_meta` |

前 8 个场景**不带 `provider`**（P60/A9 基线不变），这也由
`wrapper_scenarios_carry_their_catalog_provider` 常驻断言锁定；两个 wrapper 场景带真实
`provider`，是「声明是 provider 作用域」的可检查凭据（两份基线并排对比即可看出）。
原 8 场景不得删改或重排（`golden_trace_scenarios_match_construction_book` 的前缀断言）。

A2 的 launch plan 基线不在本目录：它是 `shared/agent-launch-plan.fixture.json`
（argv 顺序 / cwd / env / 脱敏），由 `pylon-core` 的测试以 `include_str!` 消费。

## 记录形状

每行一条归一化 `WireRecord`（JSONL）：

- 保留：`direction` / `method` / `idKind` / `idValue` / `params` / `result` / `error` /
  `status` / `remoteSessionId` / `toolCallId` 等协议事实；
- `idValue` 在每条连接内按首次出现顺序归一化（number=`1..N`，string=`wire-1..N`），
  保留 `idKind` 与请求/响应关联，避免 SDK UUID 造成机器相关差异；
- 丢弃：`traceId`、`timestamp`（机器相关，无法逐字节复现）；
- 补身份三轴：`owner`（durable session owner key）、`generation`（`clientGeneration`）、
  `ordinal`（= `monotonicSeq`），另加 `scenario` 与 `connection`（连接序号，reconnect 为 1/2）。

`ordinal` 是**连接内**序号：reconnect 的第二条连接从 1 重新计数，靠 `connection` 区分。

## 纪律

- 本目录是基线，不是运行时代码；不得为了让单次运行跑绿而改基线。
- A1c 删除 legacy 并启用 SDK 属于已批准的新实现契约；因此本次基线更新须在 A9 台账记录
  「旧 legacy 基线 → SDK 基线」的差异摘要与理由。
