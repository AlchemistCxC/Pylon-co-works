# L.md · 并行施工协调板

> 规则（AGENTS.md §2.3-4）：并行多 agent 施工时，在此声明施工范围以应对冲突（文件互相改写、连带提交等），**写入后立刻提交本文件**使其他 agent 可见。只追写，不覆写，留言简洁。

> **只留在途。** 本文件的价值是「谁正在改哪些文件」；已完工的条目占用读取代价，并且**文件越长、两边各自追加就越容易冲突**（本文件历史上多次成为合并冲突点）。所以自己的 issue 合入后即可移除自己的条目。2026-09-16 及以前的条目（其 issue 均已有 `.agents/records/` 开发记录）已归档到仓外 `../Docs/Archive/L-archive-20260918.md`；2026-09-17 至 2026-09-25 的已完工条目（#110/#315/#316/#317 批次一/ADR 通审等）已归档到仓外 `../Docs/Archive/L-archive-20260925.md`；2026-09-26 撤下的已完工 [kumo] 条目（#324/#331/#334-336/#338/#339/#325-329，issue 均已 CLOSED 且改动已并入 main）已归档到 `../Docs/Archive/L-archive-20260926.md`；[Codex] #155 T3 已随 PR #347 并入 main 撤下。

- [kumo] #351 前端根目录归类（#245 前端对应件）：`src/` 根 22 文件按域下沉（identity→`domains/identity/`、IPC 件→`infrastructure/{persistence,skin}/`、workspace/runtime/cc→各自 domains、error 三件→`app/`、其余就近）+ **全仓 import 路径重写**（触及 src 广泛文件的 import 行，语义零变更）+ 断 `identityStore→workspace/runtime`（新增 `src/app/bootstrap/identityCrossDomainSync.ts` 端口）+ `scripts/check-runtime-boundaries.mts` allowlist ×3 路径随迁 + `scripts/audit-maintenance.test.mts` 断言随迁 + 说明书文件链接同步。规格 `.agents/spec/351-frontend-root-file-relocation.md`。**不碰** `store.ts`/主题预设集群与 `presets//zones/`（#266 域）、`src-tauri/**`（#348/#349 在途）、入口四件。
- [kumo] #348+#349 ACP 连接缺陷批次（单 PR，两个施工 agent 按文件域互斥并行）：
  - #348 → `src-tauri/pylon-acp/**`（**不含 `src/adapter/`**）、`src-tauri/pylon-acp/Cargo.toml`、`src-tauri/Cargo.toml`、`src-tauri/vendor/acp/ORIGIN.md`：写侧崩溃终因词表一致性 / 版本声明对齐 / spawn 补 CREATE_NO_WINDOW / reducer 补 available_commands_update 臂 / `is_method_not_found` 兜底收窄 / protocol_version 接受集合 fail-closed。
  - #349 → `src-tauri/src/session/create.rs`、`src-tauri/src/session/fork.rs`（注释）、`src-tauri/src/dispatcher/interaction_route.rs`、`src-tauri/src/private_interaction.rs`、`src-tauri/pylon-acp/src/adapter/**`（自 #348 域切出）：revive 路径 session/load 回放治理 / elicitation request-scoped 入桥（广告⇔执行不一致）。
  - 规格 `.agents/spec/348-acp-engine-core-defects.md`、`.agents/spec/349-host-session-lifecycle-defects.md`。
  - **两边都不碰**：`src-tauri/src/dispatcher/mod.rs`、`pylon-session/**`、前端、`docs/说明书/**` 之外的文档。
  - 明确留给后续 issue（本批不做）：fs/terminal 错误码细化（改 agent 侧 wire 码）、`-32000 AuthRequired` 语义消费、Windows `.cmd/.bat` + UNC cwd 绕行、cancel settle 窗口（待复核）。
  - 返工轮（独立审查反馈）：触及 `src-tauri/src/acp/tests.rs`（A6 测试裁决改写）与大批原域内文件；**前端死词条清理（A1 摘除 `WriterTimeout` 后的 `errorCodeExplanations.ts` 等）不在本批**——那些路径属在途 #351（`e0538758` 已下沉 error 三件到 `src/app/`），改由 issue 跟进。
  - 审查结论（独立 agent）：A1 误报审查通过、A6 裁决成立、#349 对规格的机制更正成立、B4 跳过理由成立；必修项为「B2 条件宽化」与「B2 端到端缺前端应答门（已回退准入，转 issue #356）」。
- [Penrose] #358 复活会话缺协商事实（配置卡消不掉）：`src/sheets/agent-workbench/sessionResponseProjection.ts`（新增可选 `syntheticReason` 尾参，默认值不变）、`agentWorkbenchSession.ts`（`applySessionResponse` 透传标注 + pending 携带）、`agentWorkbenchLifecycle.ts`（新增宿主缝 `onSessionLoadResponse`）、`AgentRendererSuiteWorkbench.tsx`（接线）；用例新增在 `src/sheets/agent-workbench/__tests__/` 与 `src/renderers/solid-workbench/__tests__/`。规格 `.agents/spec/358-revive-negotiation-surface.md`。**不碰** `WorkbenchDocumentSurface.solid.tsx` 的守卫语义、`src-tauri/**`、`pylon-session/**`、#351 域（`src/` 根件下沉）。
