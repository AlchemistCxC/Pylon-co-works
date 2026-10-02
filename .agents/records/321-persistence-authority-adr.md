# Dev Record — 321 双模式持久化契约 ADR 补录与 issue 收尾

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#321（验收判据收尾——ADR 补录）
- 分支：`kumo/321-persistence-adr`（基于 github/main `f34ca356`；worktree 隔离施工，见「并行交集」）
- 日期：2026-10-01

## 目标与范围

#321 两条验收判据的收口状态：

1. **双模式持久化契约形成 ADR 决议** → 决议已于 2026-09-28 由用户在 #321 评论区拍板（「收敛到后端权威；browser 预览 localStorage 直写分支永续保留，Tauri 模式 SQLite 单权威」），但 `.agents/decisions/` 未见落地（#448 开发记录未解问题 2 点名「是否补录 ADR 归仓库主裁决」）。本批按用户指令「完成 issue 321」补录 **ADR-0036**。
2. **依据决议登记实施 issue** → #448 已于 2026-09-30 实施完毕并关闭（三域收敛）；写穿健壮性遗留由 #463 补齐（同日），#463 保持开放仅因两项待裁决决策口。

**做什么**：ADR-0036 补录（`.agents/decisions/0036-persistence-authority-dual-mode-contract.md`）+ issue 回写。**不做什么**：不改任何代码与持久化路径（#321 原文明文约束）；不代办 #463 的两项裁决口（wire 契约变更 + approval-mode 绕锁面，留仓库主）。

## 方案要点

- ADR 忠实于决议原文（双模式契约），配套条文（写模型/对账/迁移策略）从 #448/#463 已落地行为归纳，不引入新裁决。
- 证据节行号全部按基线 `47743a28` 重新核实（#321 正文与 #448 spec 的行号均系旧结构，经 #351 重定位与 #448 落地后已漂移）：identity 域现位于 `src/domains/identity/`，approval 写穿在 `permission.rs:490-504`，两个收敛 repository 的标志/影子在 `inputPredictionSettingsRepository.ts:57-68` / `customPresetRepository.ts:49,121-128`。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| ADR-0036 与决议原文一致 | ✅ 决定节逐条对照 #321 评论区决议与 #448 记录 |
| 证据 file:line 有效 | ✅ 全部在基线 `47743a28` 实测（grep/sed 核对，非沿用旧行号） |
| issue 回写 | ✅ 见下方证据 |

## 未解问题

1. **#463 两项决策口**（落盘降级外部不可查；`user_data_save` 盲写 `approval-mode` 绕锁面）——已在 ADR-0036「风险/开放决策口」登记指引，待仓库主裁决后另行施工。
2. **identity 后续阶段**（写穿协议整体改造四项）——#448 记录未解问题 4 原样保留，另批评估。
3. #321 正文遗留的旧行号不在本批修正范围（issue 正文是历史调查快照，ADR 证据节已是权威行号）。

## 并行交集

本批只新增两个文档文件（decisions/0036、records/321），与 L.md 在途的 [Codex] 条目（agent detection 域）零交集。**未写 L.md 在途条目**：L.md 已被 [Codex] 未提交改动占用，`git commit -- .agents/L.md` 会连带提交他人条目（违背 §2.1 不 stage 他人在途改动）；本任务单会话内完成且文件域全新，无冲突风险。
