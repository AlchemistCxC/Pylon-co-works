# L.md · 并行施工协调板

> 规则（AGENTS.md §2.3-4）：并行多 agent 施工时，在此声明施工范围以应对冲突（文件互相改写、连带提交等），**写入后立刻提交本文件**使其他 agent 可见。只追写，不覆写，留言简洁。

> **只留在途。** 本文件的价值是「谁正在改哪些文件」；已完工的条目占用读取代价，并且**文件越长、两边各自追加就越容易冲突**（本文件历史上多次成为合并冲突点）。所以自己的 issue 合入后即可移除自己的条目。2026-09-16 及以前的条目（其 issue 均已有 `.agents/records/` 开发记录）已归档到仓外 `../Docs/Archive/L-archive-20260918.md`；2026-09-17 至 2026-09-25 的已完工条目（#110/#315/#316/#317 批次一/ADR 通审等）已归档到仓外 `../Docs/Archive/L-archive-20260925.md`。

---

[2026-09-25 05] [Kumo] [#317]

**开工：issue317 异味清偿批次二（结构性拆分，用户已裁断四项全做，顺序①→④）——①TS 工厂 `createAgentWorkbenchSessionRuntime` 拆分 → ②错误边界三层统一（6 份 Serialize 去重 + 33 命令签名收编 PylonError + AcpError 边界区分度 + 前端提取逻辑收口 errorPayload.ts）→ ③原子写正身下沉 pylon-foundations → ④dispatcher 提取 6 子模块；localStorage/SQLite 双写剥离另立。** spec：`.agents/spec/317-smell-cleanup-batch2.md`；决策：ADR-0025。

本轮文件域（请勿改写、勿连带提交）：
- 前端①：`src/sheets/agent-workbench/**`（`agentWorkbenchSession.ts` 拆分及新增子模块、同目录测试）
- 前端②：`src/infrastructure/tauri/errorPayload.ts`、`src/runtimeError.ts`、`src/userDataRepository.ts`、`src/components/chat/messagePersistence.ts`、`src/components/chat/chatReplayTrace.ts`、`src/infrastructure/events/canonicalEventRepository.ts`、`src/infrastructure/events/canonicalEventPersistScheduler.ts`、`src/retentionPolicyRepository.ts`、`src/components/settings/AgentRuntimePanel.tsx`、`src/cli/pylonCliDomainPorts.ts`
- 后端②：`src-tauri/src/error.rs`、`src-tauri/src/acp/mod.rs`、`src-tauri/src/gateway/{instance.rs,cmds.rs}`、`src-tauri/pylon-session/src/{event_repo,msg_repo,user_data.rs,retention.rs,error.rs}`、以及 session/lifecycle/plugin_process/hook_bridge/pylon_cli 等处 `#[tauri::command]` 签名与 map_err 调用面
- 后端③④：`src-tauri/src/agent_config/atomic_write.rs`、`src-tauri/pylon-foundations/src/workspace.rs`、`src-tauri/src/dispatcher/**`
- 记录：`.agents/records/317-*-batch2.md`（完工时新增）、`.agents/spec/317-smell-cleanup-batch2.md`、本文件

**我不碰**：`.agents/decisions/**`（ADR-0025 除外）、`package.json`/锁文件、codex 遗留工作树；测试文件仅随对应域同步修正。
