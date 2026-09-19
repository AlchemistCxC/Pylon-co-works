# Dev Record — #155 dispatcher batch window

## 元信息

- issue: #155
- branch: `Ru5t/Reflector`
- date: 2026-09-19
- scope: `src-tauri/src/dispatcher/mod.rs`

## 目标与边界

把 T1 的 `EventService::ingest_events` seam 接入 ACP live dispatcher。窗口只合并同一
`durable owner`、remote session 和 client generation 的 live `session/update`；仍逐条
生成 canonical row，终态产生的 `turn.unit` 只作为同一事务的附加 row。本轮不改 schema、
前端 cursor 或在途 draft/历史聚合模型。

## 行为

- pending window 最多 32 条，空闲 8ms 触发 flush；控制帧、回放、session/owner 切换、
  终态（done/error/cancelled）和窗口上限也会 flush。
- flush 调用一次 `EventService::ingest_events`，随后按原通知顺序记录 wire ordinal、
  持久化 snapshot、应用 Pet effects，再向 Channel/Gateway 发布；未提交批次不会发布。
- `turn.unit` 不与输入 row 一一配对，flush 配对时跳过它，但保留其 durable row 和
  最终 revision；因此终态后的输入仍从 unit sequence 继续编号。
- owner/session 检查保证事务不会跨 durable owner；owner 切换先 flush 旧窗口。

## 验收

| 检查 | 结果 |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib dispatcher::tests::pending_batch_commits_rows_before_ordered_channel_publish -- --exact --nocapture` | 1 passed |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib dispatcher::tests -- --nocapture` | 20 passed |
| `cargo test --manifest-path src-tauri/Cargo.toml --features test-agent --lib acp::tests::writer_failure_signals_watch_and_pending_settles -- --exact --nocapture` | 1 passed |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | passed |
| `git diff --check` | passed |

?? library ???`cargo test --manifest-path src-tauri/Cargo.toml --lib` ? 1098 passed?0 failed?4 ignored?1102 tests??

新增回归验证同一事务提交两条 row 后，Channel 仍按 sequence 1、2 发布，wire ordinal 1、2
分别关联正确 eventId/sequence，并共享该批次最终 revision。

## 限制

本轮没有建立 WAL/吞吐基线，也没有做真实 WebView2 验收；8ms/32 条窗口是调度层 seam，
不代表 schema 聚合或前端 sink 已投入生产。完整 library 测试中的 fake-agent 失败已用
备用 target 重建后单独复验通过。

## CI 收口（2026-09-19，PR #180 clippy 基线门禁红）

CI Rust job 在「clippy（workspace + 基线门禁）」步判红：相对基线新增 3 条诊断（pylon
crate，9 条对基线 6 条）。逐条处置，只修不扩基线：

1. `session/turn_rollup.rs` `delta_sequence_span`——3 处 `let…else { return None }`
   触发 `clippy::question_mark`；函数本返回 `Option`，改写为 `?`（语义不变）。
2. `dispatcher/mod.rs` `flush_pending_canonical`——新增第 9 参（event_service）触发
   `clippy::too_many_arguments` (9/7)；沿用文件内 `handle_session_update` 等既有惯例
   加 `#[allow]` + 理由注释（显式参数风格，结构体重构收益低）。
3. `session/event_repo.rs` `ingest_kernel_event`——单数便捷入口在生产路径被批量版
   `ingest_events → ingest_kernel_events` 取代，仅 `#[cfg(test)]` 测试调用，lib target
   判 `dead_code`；加 `#[cfg(test)]`（文件内已有测试专用方法先例）。

复验证据（本地，与 CI 同命令）：

| 检查 | 结果 |
| --- | --- |
| `cargo clippy --workspace --all-targets --message-format=json` + `check-clippy-baseline.mjs` ×4 crate | `added: []`（pylon current 6 = 基线 6），GATE_FAILED=0 |
| `cargo fmt -- --check` | passed |
| `cargo test --lib session::` | 242 passed, 0 failed |
| `cargo test --lib dispatcher::tests` | 20 passed, 0 failed |

注：session 全量首跑 23 红 + dispatcher 1 红，根因均为本机缺
`pylon-fake-agent` bin（`cargo build --bin pylon-fake-agent --features test-agent`
后复跑全绿），与本次改动无关。另见 CI 侧 pylon-core 有一条基线内
`needless_return` 随工具链升级消失（removed 只作 info，不影响门禁）。
