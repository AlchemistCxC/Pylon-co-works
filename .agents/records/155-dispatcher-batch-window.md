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
