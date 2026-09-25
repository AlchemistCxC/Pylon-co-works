# L.md · 并行施工协调板

> 规则（AGENTS.md §2.3-4）：并行多 agent 施工时，在此声明施工范围以应对冲突（文件互相改写、连带提交等），**写入后立刻提交本文件**使其他 agent 可见。只追写，不覆写，留言简洁。

> **只留在途。** 本文件的价值是「谁正在改哪些文件」；已完工的条目占用读取代价，并且**文件越长、两边各自追加就越容易冲突**（本文件历史上多次成为合并冲突点）。所以自己的 issue 合入后即可移除自己的条目。2026-09-16 及以前的条目（其 issue 均已有 `.agents/records/` 开发记录）已归档到仓外 `../Docs/Archive/L-archive-20260918.md`；2026-09-17 至 2026-09-25 的已完工条目（#110/#315/#316/#317 批次一/ADR 通审等）已归档到仓外 `../Docs/Archive/L-archive-20260925.md`；2026-09-26 撤下的已完工 [kumo] 条目（#324/#331/#334-336/#338/#339/#325-329，issue 均已 CLOSED 且改动已并入 main）已归档到 `../Docs/Archive/L-archive-20260926.md`。

- [Codex] #155 T3：隔离工作树 codex/issue-155-t3；pylon-session draft 存储/迁移、dispatcher/{canonical_flush,draft_flush}.rs、session/{prompt,control}.rs、runtime.rs、canonical feed 与 Workbench 草稿投影、对应测试和说明书。已两轮对齐主线（#334–336 的 NotificationPump/CanonicalFlushContext 与 Arc payload 已融合；本轮再合 #338/#345/#346），PR #347 待审。
- [kumo] #348+#349 ACP 连接缺陷批次（单 PR，两个施工 agent 按文件域互斥并行）：#348 → `src-tauri/pylon-acp/**`、`src-tauri/pylon-acp/Cargo.toml`、`src-tauri/Cargo.toml` 版本声明注释、`src-tauri/vendor/acp/ORIGIN.md`（写侧崩溃终因词表一致性 / 版本声明对齐 / spawn 补 CREATE_NO_WINDOW / reducer 补臂）；#349 → `src-tauri/src/session/create.rs`、`src-tauri/src/dispatcher/interaction_route.rs`（revive 路径 session/load 回放治理 / 私有交互缺 sessionId 错码；cancel settle 窗口待复核后再定）。规格 `.agents/spec/348-acp-engine-core-defects.md`、`.agents/spec/349-host-session-lifecycle-defects.md`。**不动** `pylon-session/**`、`src-tauri/src/dispatcher/{mod.rs,canonical_flush.rs,draft_flush.rs}`、前端。
