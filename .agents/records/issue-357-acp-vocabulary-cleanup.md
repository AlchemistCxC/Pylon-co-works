# Dev Record — #357 ACP 死词条清理 + 前端↔Rust 词表对齐门禁

## 元信息

- issue：#357
- 分支：`kumo/prometheus`
- 提交范围：`aba519e7..<本次 PR head>`
- 日期：2026-09-26

## 目标与范围

issue 期望原话：「删除这三处死词条，并把 `errorCodeExplanations.test.ts` 的期望集与 Rust 侧 `AcpError::code()` / `cause.rs` 封闭集重新对齐（**最好能有一条机制防止两边再漂移**——这是两次契约漂移的根因）。」前提「待 #351 合入后」已满足（#351 随 PR #355 并入 main）。

做：删死词条（实际核查出 4 处，比 issue 点名的 3 处多 1 处测试期望集）；`writer_failed` 文案对齐 #348 后语义；建跨语言词表对齐门禁。
不做：**不碰 `src-tauri/**`**（只读解析）——`PendingLockPoisoned` 摘除需改 `engine.rs`，属在途 #363 文件域；不碰 `package.json`（在途 #371 文件域）；不动 `write_timeout`（`AcpError::WriteTimeout` 活码，与死码 `writer_timeout` 是两个码）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/app/errorCodeExplanations.ts` | 崩因节提为子表 `ACP_CRASH_CAUSE_EXPLANATIONS` + 导出 `ACP_CRASH_CAUSE_CODES`（主表 spread，消费者形状不变）；删 `writer_timeout` 条；`writer_failed` 文案改「管道通信失败（stdin 写 / stdout 读物理 IO 错误）」 | 修改 |
| `src/app/__tests__/errorCodeExplanations.test.ts` | EXPECTED_CODES 删 `'writer_timeout'` | 修改 |
| `src/domains/workbench/generationLedgerSummary.ts` | `LEDGER_FAILURE_CAUSES` 删 `'writerTimeout'` 并导出（供门禁/测试消费） | 修改 |
| `src/domains/workbench/__tests__/generationLedgerSummary.test.ts` | 失败侧循环表改迭代 `LEDGER_FAILURE_CAUSES`（消灭手工副本） | 修改 |
| `scripts/acp-vocabulary.test.mts` | 跨语言词表对齐门禁 + 解析器自测 | 新增 |

## 方案要点

- **对齐原则**：前端镜像 Rust **封闭词表本身**，而非产生频率。`#[allow(dead_code)]` 预留变体（`firstTokenTimeout`/`idleTimeout`/账本侧 `writerFailed`/`overloaded`）仍在封闭集内，保留映射；无产生点但被 #348 返工裁定豁免保留的 `pending_lock_poisoned`（engine.rs 文档注释：「前端词条收编或删除后应一并摘除本变体」）两侧同轮摘除——门禁使该轮强制同步。
- **门禁**（house 先例：`check-ipc-contract.mts` 的解析思想 × `audit-maintenance.test.mts` 的 vitest 形态，进 vitest glob 自动纳管，不改 package.json）：
  1. `engine.rs::CrashReason::as_str` wire 码集 ≡ `ACP_CRASH_CAUSE_CODES`（双向精确：死词条/漏词条都红）；
  2. `turn_ledger.rs::TurnTerminalCause` serde camelCase 标签全集 − {completed, cancelled, emptyTurn} ≡ `LEDGER_FAILURE_CAUSES`；并断言 `rename_all = "camelCase"` 未变（标签形态变更显性失效）；
  3. `error.rs::AcpError::code()` 全码 ⊆ 码表键（单向覆盖——这些码在前端表散布多节且与其它词表源共用，无法精确切节）。
  解析器双层锚定（impl 块 → 函数块）+ 合成输入自测；解析为空一律红灯，不允许静默放行。
- **A1 死词条全账**（核查后 4 处，issue 点名 3 处 + 本轮发现的 ledger 测试手工副本）：errorCodeExplanations.ts:44、其测试 :22、generationLedgerSummary.ts:40、其测试 :37。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁 + 两个直接测试套全绿 | ✅ `3 files / 24 tests passed`（多次复跑一致） |
| 变异检查·死词条方向（前端塞假崩因码） | ✅ CrashReason 断言红，点名 `ACP_CRASH_CAUSE_EXPLANATIONS` |
| 变异检查·漏认方向（ledger 删活标签 `overloaded`） | ✅ TurnTerminalCause 断言红，点名文件/集合/后果 |
| lint / tsc | ✅ eslint 五文件零发现；`tsc -b` EXIT 0 |
| `src/` 内死码残留 | ✅ 活词条 0；仅余 2 处**说明性注释**记录先例（本轮有意保留的历史引注） |
| 全量 | ⚠️ 见下「证据」——并发在途窗口无法取得干净全量，CI 为权威门禁 |

## 测试处置

- 新增：`scripts/acp-vocabulary.test.mts`（4 解析器自测 + 3 跨语言比对）。
- 修改：errorCodeExplanations.test.ts（期望集删死码）；generationLedgerSummary.test.ts（循环表消费导出集合，断言语义不变）。

## 证据

- 门禁/单测：`Test Files 3 passed (3) / Tests 24 passed (24)`；变异两向各红一次后复原回绿（失败信息分别点名死词条与漏认标签）。
- `bunx eslint`（5 文件）零输出；`bunx tsc -b` exit 0。
- **全量说明**：本次窗口内共享工作树有三个 agent 在途（#361-363 改 src-tauri、#371 改前端 docs-sheet 链），全量出现 39 文件红：其中约 35 个为「0 test」收集失败且**逐个隔离复跑即绿**（抽查 mountSolidWorkbench 96/96、SessionSurfaceCard 8/8），系并发满载下的墙钟坍缩（#175 记录的并发模式）；其余为 #371 自己的在途新测试（`DocsSheetView.boundsSync`）与半接线注册表（sheetRegistry.compat）。上述文件域均不在本改动内，且 `git status` 可证其未提交在途状态。**权威全量门禁 = 本 PR 的 CI**（CI 检出已提交状态，不含工作树在途污染），结果随 PR 跟进。

## 与 spec 的偏差

无实质偏差。spec 验收第 4 条「全量绿」在共享树并发窗口内不可取得干净证据，改为「相关单测多轮绿 + 隔离抽查 + PR CI 全量」，已在 issue 评论区如实说明。

## 未解问题

- `pending_lock_poisoned` 双侧同轮摘除（Rust 变体 + 前端词条），依赖 `engine.rs`（#363 在途域），留待该域收工后的后续轮；门禁届时会强制两侧同步（谁先动谁红灯）。

## 并行交集

- 共享文件：仅 `.agents/L.md`（已单独提交声明）。#361-363/#371 的在途文件（含 `engine.rs`、`package.json`）零触碰。
- 事故记录：验证中途一次 `git checkout --` 误将本改动两个未提交源文件一并回退（本意仅撤变异注入），已当即按原编辑完整重做并以 `git diff` 逐行核对；无他人文件受影响。
