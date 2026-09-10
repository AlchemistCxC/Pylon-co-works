# ACP golden trace 基线（A0）

本目录是 **P60/A0** 建立的「换引擎前」Pylon 手写 ACP 的 wire 时序基线，用于
A1c（旧路径删除前）与 A9（shadow parity）的逐场景比对。

## 生成与校验

```powershell
node scripts/generate-acp-golden-trace.mjs           # 重新生成并覆盖本目录
node scripts/generate-acp-golden-trace.mjs --check   # 只校验：两遍运行一致 + 与已提交基线一致
```

生成器本体是 test-only 的 Rust 测试
（`src-tauri/src/acp/golden_trace_tests.rs`，由 `PYLON_GOLDEN_TRACE_DIR` 启用），
脚本负责两次运行的确定性比对与落盘。未设置该环境变量时，该测试是 no-op，
因此常规 `cargo test --lib acp::` 不受影响。

## 场景（8 个，对应施工书 §A0 步骤 4）

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

## 记录形状

每行一条归一化 `WireRecord`（JSONL）：

- 保留：`direction` / `method` / `idKind` / `idValue` / `params` / `result` / `error` /
  `status` / `remoteSessionId` / `toolCallId` 等协议事实；
- 丢弃：`traceId`、`timestamp`（机器相关，无法逐字节复现）；
- 补身份三轴：`owner`（durable session owner key）、`generation`（`clientGeneration`）、
  `ordinal`（= `monotonicSeq`），另加 `scenario` 与 `connection`（连接序号，reconnect 为 1/2）。

`ordinal` 是**连接内**序号：reconnect 的第二条连接从 1 重新计数，靠 `connection` 区分。

## 纪律

- 本目录是基线，不是运行时代码；不得为了让 A1 新引擎跑绿而改基线。
- 若因**新契约**必须变更基线，须在该片施工书验收项中点名，并在台账记录
  「旧基线 → 新基线」的差异摘要与理由。
