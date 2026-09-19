# Dev Record — #155 kernel ingest T1 batch seam

## 元信息

- issue: #155
- branch: `Ru5t/Reflector`
- date: 2026-09-19
- scope: `src-tauri/src/session/event_repo.rs`, `src-tauri/src/session/turn_rollup.rs`

## 目标与边界

本轮实现 ADR-0008 的 T1 基础切片：为 kernel ingest 提供同 owner 的批量 transaction seam，保持逐 chunk append-only 行与既有序列/重放行为；同时让已存在的 `*.delta.batch` 输入参与 turn rollup，避免聚合输入改变 `contentSha256`。

dispatcher 仍未接入批量窗口；因此本记录不把 #155 的 WAL、schema 或生产吞吐验收写成已完成。

## 改动

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/session/event_repo.rs` | `ingest_kernel_events` 单事务批处理；`EventService::ingest_events`；单事件入口复用；batch/owner/terminal sequence 测试 | 修改 |
| `src-tauri/src/session/turn_rollup.rs` | batch delta 类型映射；按 `seqSpan` 折叠；解除等价性测试 ignore | 修改 |
| `.agents/spec/155-kernel-ingest-batch.md` | T1 规格、边界与验收证据 | 新增（gitignored） |

## 关键实现

- 批量输入必须属于同一 owner；混 owner 在开启 transaction 前拒绝，不写入任何行。
- 每条输入仍生成一条 canonical row；terminal 行后在同一 transaction 追加 `turn.unit`，后续输入从 unit sequence 继续分配。
- `*.delta.batch` 的 `sequence` 是跨度末端，rollup 使用 `typedPayload.seqSpan` 的首尾，文本仍取已拼接的 `typedPayload.text`。
- 缺少或非法 `seqSpan` 的 batch 在 rollup 中回退为单行 sequence，避免 malformed payload 导致 panic。

## 验收结果

| 检查 | 结果 |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib session::event_repo::tests` | 46 passed, 0 failed |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib session::turn_rollup::tests` | 8 passed, 0 failed |
| `git diff --check` | passed |

新增回归覆盖：批量行序列与 terminal unit 推进、混 owner 原子拒绝、聚合行与原始 chunk 的 segment/SHA 等价。

## 与 spec 的偏差

规格中的“批量 ingest seam”已落地；“生产 dispatcher 窗口接线”明确留在下一切片，因此当前没有 WAL/吞吐改善证据，也没有修改前端或 schema。

## 未决与下一步

- 在 dispatcher 层保存同 owner pending 输入，遇到消息边界/预算/终帧时调用 `EventService::ingest_events`，并按返回 rows 顺序完成 durable-before-publish。
- 接线前补充 wire ordinal、channel frame 与多 row commit 的回归测试。
- 只有生产接线并取得基线后，再评估 ADR-0008 的 T2 schema 重建与 T3 draft/历史聚合。
