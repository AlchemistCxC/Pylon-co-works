# Dev Record — #457 根目录散落文件整理

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：[#457](https://github.com/AlchemistCxC/Pylon-co-works/issues/457)
- 分支：`kumo/439-review-fixes`
- 提交范围：`197034df..8543d031`（单提交），PR #458
- 日期：2026-09-29

## 目标与范围

清偿根目录积压的施工期散落条目：删僵尸、留追溯、给在役文件落位，使共享 `git status` 恢复「只剩在途」的信号价值。

**不做**：不动生产代码（`src/`、`src-tauri/` 零触碰）；不清理 `.agents/spec/` 陈旧条目（另行登记）；不动 gitignored 构建产物目录（`dist*`/`coverage/`/`artifacts/`/`target/`/`release/`）；不撤 L.md 陈旧条目（归档节奏由其自身规则管辖）；不动在役根目录文件（`BOARD.md` 退役路标——ADR-0010、`solid-*-qa.html`/`vite.solid-smoke.config.ts` smoke 门禁、`agents.example.yaml`、`.pi-lens.json`）。

## 改动清单

仓库足迹（入库，单提交）：

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `CLAUDE.md` | 全文（32B 指针 →AGENTS.md） | 新增入库（原 untracked） |
| `design-qa.md` → `docs/tactical-blue/design-qa.md` | 全文迁移 | 移动（原根目录 gitignored） |
| `docs/tactical-blue/README.md` | 「验证记录」节引用行 | 修改（悬空引用 → 目录内相对路径） |
| `.gitignore` | P91 B3 段 | 修改（`design-qa.md` 锚定为 `/design-qa.md` + 注释更新） |

无仓库足迹的清理（未跟踪/被忽略文件，不进 git）：

| 处置 | 对象 | 依据 |
| --- | --- | --- |
| 硬删 | `_fix.py`、`_q.py`、`_q2.py` | 对 `F:\Hermes\...`（外部项目）的一次性脚本，与本仓零关联 |
| 硬删 | `_research/` 其余全部（比价 HTML 快照 ~13MB、`strip.py`、`dbcopy/pylon-data-v1.sqlite3` 调试副本） | 无引用残渣；DB 为应用数据的可再生存副本 |
| 硬删 | `_struct/` 17 件（一次性 codemod + `pr-body.md`） | 批随 PR #455 合入，用途已尽，全仓无引用 |
| 硬删 | `chat-centering-412-qa.html` | #412 已 CLOSED，无引用 |
| 归档仓外 | `_refactor-recon/` 8 件 → `../Docs/Archive/refactor-recon-416/` | #416 调查/施工日志，被入库记录 `416-*`/`425-*`、spec `424-*` 引用 |
| 归档仓外 | 4 份评审报告 → `../Docs/Archive/frontend-structure-review-pr455/` | `frontend-structure-review-{A-view,B-logic,R1,R2}.md`，被入库记录 `2026-09-29-frontend-structure-overhaul.md` 引用 |

## 方案要点

- **删/留判据**：无任何引用 + 用途已尽 → 删；被已入库记录引用 → 归档仓外 `../Docs/Archive/`（同 L-archive 先例，不入库）；在役（被 package.json/门禁/README 引用）→ 原地不动或落位。
- `design-qa.md` 选择入库落位而非仓外归档：它是已完结批次的最终验收结论，README 的引用若指向仓外路径对其他贡献者无效；与其 screenshots 同目录是唯一不产生悬空引用的落点。gitignore 规则随之锚定根路径，保留对根目录未来同名草稿的拦截。
- `CLAUDE.md` 入库是「协作规范随仓库分发」惯例（.gitignore 内 2026-09-14 注）的自然延伸。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 根目录散落脚手架清零 | ✅ 提交后 `git status --porcelain` 输出为空 |
| 归档件可对号查得 | ✅ `../Docs/Archive/refactor-recon-416/`（8 件）、`../Docs/Archive/frontend-structure-review-pr455/`（4 件） |
| README 无悬空引用 | ✅ 改指本目录 `design-qa.md`；`docs/tactical-blue/design-qa.md` `check-ignore` rc=1 |
| 门禁不受影响 | ✅ 零代码路径改动，无白名单豁免新增 |

## 测试处置

无测试修改/删除（纯文件结构与文档）。

## 证据

- commit：`8543d031`（4 files, +38/−3）；PR #458
- 手工验证：`git status --porcelain` 空；`gh pr view 455` MERGED、`gh issue view 412` CLOSED（删除依据核实）；归档目录 `ls` 清单见上文
- 引用排查：`grep -rn "_research\|_refactor-recon\|_struct\|chat-centering-412-qa\|design-qa"` 于 `.agents/`、`docs/`、`CONTEXT.md`，命中者全部为归档保留件或在役引用

## 与 spec 的偏差

未落 spec 文档（任务轻量、单会话完成，目标/范围/验收已由 issue #457 承接，本记录即其归宿）。

## 未解问题

- `.agents/spec/` 内大量已完结 issue 的一次性文档（含 `scan_deps.py`、`tmp-consumer-scan.mjs`、`_c371*.md`、check log 残留）未清理，属独立事项。
- 历史入库记录中的 `_research/…`、`_refactor-recon/…` 路径引用自此指向仓外归档新址（`../Docs/Archive/…`），记录正文按惯例不回改。

## 并行交集

- 共享 tracked 文件仅 `.gitignore`、`docs/tactical-blue/README.md` 两处改动 + `CLAUDE.md`、`docs/tactical-blue/design-qa.md` 两个新增，均已随 `8543d031` 提交，无在途遗留。
- 未跟踪域的 `_research/`、`_struct/`、`_refactor-recon/` 已整体移除，后续会话勿再按旧路径找评审/调查材料（新址见上表）。
