# L.md · 并行施工协调板

> 规则（AGENTS.md §2.3-4）：并行多 agent 施工时，在此声明施工范围以应对冲突（文件互相改写、连带提交等），**写入后立刻提交本文件**使其他 agent 可见。只追写，不覆写，留言简洁。

> **只留在途。** 本文件的价值是「谁正在改哪些文件」；已完工的条目占用读取代价，并且**文件越长、两边各自追加就越容易冲突**（本文件历史上多次成为合并冲突点）。所以自己的 issue 合入后即可移除自己的条目。2026-09-16 及以前的条目（其 issue 均已有 `.agents/records/` 开发记录）已归档到仓外 `../Docs/Archive/L-archive-20260918.md`；2026-09-17 至 2026-09-25 的已完工条目（#110/#315/#316/#317 批次一/ADR 通审等）已归档到仓外 `../Docs/Archive/L-archive-20260925.md`。

- [kumo] #324 停止≠失败：`src-tauri/src/session/prompt.rs`、`src/domains/workbench/`（projector/footer/normalizer 相关）+ 各自测试；pylon-acp 只读不改。规格 `.agents/spec/issue-324-stop-not-failure.md`。易用性批次后续（#325–#330）逐项开工前在此更新。
- [kumo] #331 后端质量清偿：`pylon-session/src/retention.rs`、`src-tauri/src/browser/agent/{audit,refs}.rs`、`src-tauri/src/gateway/route.rs`、`pylon-acp/src/state.rs`、`src-tauri/src/dispatcher/canonical_flush.rs`、`src-tauri/src/session/create.rs`、`src-tauri/src/lib.rs`、`.agents/dev-standards.md`、`artifacts/clippy-baseline.json` + 各自测试；**`session/prompt.rs` 与 `src/domains/workbench/**` 属 #324，本批不动（C1 顺延至其合入）**。规格 `.agents/spec/331-backend-quality-sweep.md`。
