# Dev Record — #425 后端清理小件批（死词条/死变体/panic expect/生产出口/补缝打包）

## 元信息

- issue：#425（#417 裁决立项，仓库主 2026-09-28 批复一个 PR 打包）
- 分支：`kumo/425-backend-cleanup`（独立 worktree `G:/Project/prism-team-workdir/pylon-425`，基于 `github/main` 92c910b1）
- 提交范围：`92c910b1..<head>`（见 issue 评论区回写的最终提交）
- 日期：2026-09-28
- 施工环境说明：共享树 3 个 CSS/tsx 文件（`ControlCenter.css`、`ChatView.css`、
  `WorkbenchWidgets.solid.tsx`）有 #410 在途改动且与已合并的 PR #426 改动重叠，
  无法安全 merge main，按 #352/#353 先例在独立 worktree 隔离施工。

## 目标与范围

六件独立清理项一次 PR 清偿，`_refactor-recon` 调查报告的遗留清单归零：

1. `session/prompt/ingest.rs` owner fallback 构造处 panic `expect` → 领域错误。
2. `session/persist.rs` 映射词表死词（`already-present`/`reconciled`）清理，连测试契约。
3. `late_terminal_events` CAS 拦截计数接生产出口；`settle_by_session`/`advance` 去留决策。
4. `CrashReason::PendingLockPoisoned` 死变体摘除（Rust + 前端词条 + acp-vocabulary 门禁三处同轮）。
5. `IdentityConfidence::Exact`/`Low` 死变体裁剪（含前端死值样本）。
6. wait/settle 域三处 pet 直呼补 `KernelReactionSink` 方法完成全 sink 化。

**不做什么**：不动 #420–#423 四个大件的域；不改 wire 错误码集合（件1 用既有
`protocol_error` 码）；不动共享树任何在途文件。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/session/prompt/ingest.rs` | durable owner expect → `PylonError::Protocol` | 修改（件1） |
| `src-tauri/src/session/prompt/tests.rs` | 新增 durable owner 缺失行为测试 | 新增（件1） |
| `src-tauri/src/session/persist.rs` | 三处 status 映射 + ReplayImport 构造删死词；测试断言改活词 | 修改（件2，含测试修正） |
| `src-tauri/pylon-acp/src/turn_ledger.rs` | settle Late 分支接 `tracing::warn` 出口；getter 文档更新 | 修改（件3） |
| `src-tauri/pylon-acp/src/engine/prompt_wait.rs` | 删 `PendingLockPoisoned` 变体与 as_str 臂 | 修改（件4） |
| `src-tauri/pylon-acp/src/cause.rs` | 删 summary 臂、from_code 臂、两处测试数组 | 修改（件4） |
| `src/app/errorCodeExplanations.ts` | 删 `pending_lock_poisoned` 词条；表头注释更新 | 修改（件4） |
| `src/app/__tests__/errorCodeExplanations.test.ts` | 期望码集合同步 | 修改（件4） |
| `scripts/acp-vocabulary.test.mts` | 纪律注释更新（纪律本身不变） | 修改（件4） |
| `src-tauri/pylon-core/src/agent_detection/types.rs` | 删 `Exact`/`Low` 变体 | 修改（件5） |
| `src-tauri/pylon-core/src/agent_detection/scan.rs` | `confidence_rank` 删两臂、rank 重排 0/1 | 修改（件5） |
| `src-tauri/pylon-core/src/agent_detection/evidence.rs` | `identity_rank` 删两臂、rank 重排 0/1 | 修改（件5） |
| `src/domains/agent/agentDetector.ts` | union 与 normalize 守卫收窄为 `'high' \| 'medium'` | 修改（件5） |
| `src/domains/agent/candidateValidation.ts` | 删 `=== 'exact'` 比较与注释改写 | 修改（件5） |
| `src/domains/agent/__tests__/candidateValidation.test.ts` | 死值样本改活值（exact→high、low→medium、循环收窄） | 修改（件5） |
| `src/components/settings/__tests__/AgentRuntimePanel.default.test.tsx` | 三处 `'exact'` 样本 → `'high'` | 修改（件5） |
| `src-tauri/src/dispatcher/reactions.rs` | trait 新增 `on_prompt_error`/`on_user_sent`/`on_timeout` 三位点 + PetReactionSink 实现 + 等价锁测试 | 修改+新增（件6） |
| `src-tauri/src/session/prompt/wait.rs` | ensure 失败臂与 user 送出位点改走 sink | 修改（件6） |
| `src-tauri/src/session/prompt/settle.rs` | 超时位点改走 sink | 修改（件6） |

## 方案要点

- **件1**：`ok_or_else(|| PylonError::Protocol(...))` 上抛而非回退构造——
  `durable_owner` 文档明确「返回 None 表示平台自动会话，调用方不得补齐」，
  静默补齐会掩盖绑定状态不一致；错误码走既有 `protocol_error`，零 wire 新增。
- **件2**：死词 `already-present`/`reconciled` 从 `replay_journal_commit_outcome`、
  authority、journal_coverage、ReplayImport 四处映射删除；词表以
  `pylon-session/event_repo/service.rs` 实际产出（`imported`/`already-imported`/
  `local-authoritative`）为准。
- **件3**：出口形态选 **runtime log**（settle Late 分支 `tracing::warn!`，逐条
  打点带 turn key 与既有 cause）——诊断计数配诊断日志，零 wire；冷挂载快照
  形态被否（计数是 ledger 全局量，挂单会话快照语义不顺）。
  **`settle_by_session`/`advance` 决策：保留现状**——#420 已用 `#[cfg(test)]` +
  文档写明摘除条件（生产调用方出现时摘除）钉住，不是无主死码，本批不推翻
  ADR-0034 框架。Late 分支重复的 `expect` 表达式顺手收为单一局部变量（同一
  断言一次）。
- **件4**：三处同轮摘除——`prompt_wait.rs` 变体文档本就预告「前端词条收编或
  删除后应一并摘除本变体」，本批解除 #348 返工裁定的临时豁免。摘臂后
  `crash_reason_from_code` 对该 code 走 `_ => None`（fail-closed 不变），
  crash_reconnect 消费方行为无变化。acp-vocabulary 双向精确门禁自动对齐验证。
- **件5**：裁剪而非补构造（issue 倾向已批复）——全仓无产生点，探测面只产出
  High/Medium。rank 值从 0-3 重排为 0-1（纯比较用，排序结论不变）。前端
  normalize 守卫同步收窄后外产脏值（含旧版残留的 exact/low）仍被拒，防御不变。
- **件6**：位点命名区分语义——`on_prompt_error`（发起路径错误，turn 未 begin，
  与收尾位点 `on_turn_failed(cause)` 区分）、`on_user_sent`、`on_timeout`；
  PetReactionSink 实现逐一委托既有 `crate::pet` 函数，行为不变（等价锁测试钉住）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 每件有对应行为测试或断言 | ✅ 件1 新增 `publish_prompt_failure_returns_domain_error_when_durable_owner_missing`；件2 测试断言改活词；件3 既有 Late/计数断言看守同分支；件4 cause.rs 词表测试 + acp-vocabulary 双向门禁 + 前端码表测试；件5 前端 candidateValidation/AgentRuntimePanel 测试样本改活值（Rust 侧无 Exact/Low 构造点，删臂即验证）；件6 新增 `prompt_path_sink_methods_match_direct_pet_calls` 等价锁 |
| `cargo test -p pylon-core -p pylon-acp -p pylon --lib --features test-agent` | ✅ 925 + 193 + 137 passed / 0 failed |
| `bun run check:clippy` | ✅ 6 crate 全部 `added: []`（基线未动） |
| 直接相关前端测试（acp-vocabulary / errorCodeExplanations / candidateValidation / agentDetector / AgentRuntimePanel） | ✅ 5 文件 59 用例通过 |
| `bun run check:all` | 见 issue 评论区回写（含 workspace 全测、shadow parity、fmt） |
| 开发记录落 `.agents/records/` | ✅ 本文件 |

## 测试处置（修改/删除的测试）

- `persist.rs::replay_trace_journal_outcome_is_machine_readable`：`"reconciled"`
  断言改 `"already-imported"`（死词摘除，词表对齐 service.rs 实际产出——契约
  修正，提交说明已注明）。
- `cause.rs::crash_cause_uses_the_crash_reason_vocabulary`：两处数组删
  `PendingLockPoisoned`/`pending_lock_poisoned`（变体摘除）。
- `errorCodeExplanations.test.ts`：EXPECTED_CODES 删 `pending_lock_poisoned`。
- `candidateValidation.test.ts`：`candidate('exact')` 断言并入 `candidate('high')`、
  `candidate('low')` 断言并入 `candidate('medium')`、verified 循环收窄
  `['high', 'medium']`（类型收窄后死值样本不可构造）。
- `AgentRuntimePanel.default.test.tsx`：三处 `identityConfidence: 'exact'` →
  `'high'`（组件是字符串透传，测试意图——高可信候选场景——不变）。

## 证据

- commit：见 issue #425 评论区。
- 测试：`cargo test` 925/193/137 passed 0 failed；clippy 6 crate `added: []`；
  vitest 相关 5 文件 59 用例通过；`bun run check:all` 退出码见 issue 回写。
- 手工验证：无 UI 行为变化面（件4 前端仅删一条不会出现的错误码解释；件5
  删的是从不产出的枚举值），未做实机验收——纯词表/接缝/错误边界清理。

## 与 spec 的偏差

无（spec：`.agents/spec/425-backend-cleanup-batch.md`，落共享树不入库）。
补充一件 spec 未写的顺手清理：turn_ledger.rs Late 分支两处重复的
`record.terminal.as_ref().expect(...)` 收为单一局部变量（同一断言写一次，
行为不变）。

## 未解问题

- 无。六件全清偿。

## 并行交集

- 共享树：`.agents/L.md`（开工声明，单文件提交 `b3f6583d`）。
- worktree 内全部改动文件与共享树在途文件（#410 CSS/tsx、#412 残余 hunk）
  零交集；`errorCodeExplanations.ts` 在共享树当前为干净状态（#357 已合并）。
- 说明书核对结论：`docs/说明书/Pylon-项目架构参考.md` 仅架构级提及
  KernelReactionSink/identityConfidence（描述不随方法增删与值域收窄漂移），
  无 already-present/pending_lock_poisoned/late_terminal_events 表述——无需同步。
