# Dev Record — PR #374 整 PR 审查（跨批次）与修正

> 入库保留。本次是**整 PR**（共享分支 `kumo/prometheus` → `main`）的独立对抗式审查与随之的修正，
> 不属于单一 issue：审查对象是 47+ 提交的多批次集成结果，修正跨了 #371 / #375 / #376 / #356 / #361-363 五个域。
> 产出路径：`.agents/records/pr374-whole-pr-review.md`

## 元信息

- 对象：PR #374（基 `main`，头 `kumo/prometheus`），审查快照 `fc7473f2` 前后
- 起因：用户要求「再派个子 agent 审查整个 PR 并根据反馈修正」
- 审查方式：1 个独立子 agent（read-only），覆盖跨批次集成、整 PR 一致性、账目/合并卫生、并在 6–10 个高风险文件上做单点深审
- 日期：2026-09-27

## 审查结论（原样要点）

**合并裁决：不可直接合并**——CI 6 个 job 里 5 个红，且失败全部可归因到本 PR 的**已提交内容**（与当时工作树里 #356 的在途改动无关）。

| 级别 | 发现 | 归属 |
| --- | --- | --- |
| BLOCKING | 接口新增 `listCompact` 后 3 个测试双件未同步 → TS2741/TS2345，拖垮前端 job 与两个以 `bun run build` 为前置的 Rust job | #376-b |
| BLOCKING | sheet 注册表新增第 11 个 kind，但两处硬编码 10 的兼容/完整性 pin 未更新 | #371 |
| BLOCKING | 已提交的 `event_repo/repo.rs`、`tests.rs` 不过 `cargo fmt --check` | #376-b |
| CONCERN | 连接级空闲回收可能静默杀掉平台 agent（`Disconnected` 不自愈 + ingest 拒非 Connected 实例且无 fallback） | **#363（本批）** |
| CONCERN | PR 描述与实际 diff 严重不符；#376/#371 的 issue 线程陈旧 | 账目 |
| CONCERN | #356 在途的私有交互队列未纳入 #363 的豁免信号（落在本 PR 之后会退化） | 跨批次 |
| NIT | `repo.rs` 文档注释位置错挂 | #376-b |
| NIT | 终端错误分类按子串 | #354 |
| NIT | `bundle.resources` 让裸 `tauri build` 在干净检出上先失败 | #371 |

审查同时**确认干净**的项目（有证据）：控制台隐藏收口唯一（无重复机制）、`ensure_node_in_path` 的调用位置早于检测、#362 日志目录与 #371 资源目录互不干扰、#357 词表门禁与 #354 的新错误码对齐、`#354` fs 沙箱的 outside-roots 存在性 oracle 已消除、`#376` 分页边界与 delta run 闭合一致、打包脚本的 `agents.yaml` 位置敏感豁免成立、`86fbcb9e`（#361-363）的 hunk 分账成立。

## 修正清单（按归属）

| 项 | 归属 | 处置 | 落点 |
| --- | --- | --- | --- |
| 3 个测试双件缺 `listCompact` | #376-b | 我改了三处（空页 / 单页全量，语义如实） | 由 #375 的 `62568e39` 连带入库（作者同期独立做了同一处修正） |
| `agentWorkbenchSession.ts` 未用导入 | #375-c | 我删了该导入 | 由 `f0e9bc78` 连带入库（作者同期独立修正） |
| `permissionController.ts` TS 收窄 | #356 | 我把 `sessionId` 提成局部量、按「缺失/显式空串」两态分判（**接受集合逐条等价**，仅让类型收窄） | 由 `852e3f52` 入库（作者同期独立做了同形修正） |
| `SHEET_KINDS` 漏第 11 个 kind `docs` | #371 | 我补入并更新文件头计数 | **`088a5096`（本批提交）** |
| 两处硬编码 10 的计数 pin | #371 | 更新为 11（`sheetState.compat.test.mts`、`sheetRegistrySidebarMode.test.tsx`） | `088a5096` |
| `docs_sheet/{mod,cmds}.rs` 10 条 clippy 新增 | #371 | 删未用导入 + 9 处 `redundant_closure` → 方法引用 | `088a5096` |
| `permission.rs` 3 条 clippy 新增 | #356 | `for (request_id, _)`（`take()` 才是权威 claim）+ 文档段落空行 | `088a5096` |
| 连接级回收的平台保活 | **#363（本批）** | 新增 `platform_may_route_to`：显式路由命中，或 `unbound_policy=active-agent`（缺省）且确有适配器注册时，**不回收**该 agent 的连接；补 `connection_routed_by_the_gateway_is_never_reclaimed`；闲置时钟措辞改为「自连接起已超过 N 秒」 | `088a5096` |

**未处理（有意留下）**：

- `repo.rs` 的 fmt 与错挂注释：`#376` 作者已在工作树修掉 fmt（`cargo fmt --all --check` 现为 0 处），注释位置属其域内的小改，不做代劳。
- `#354` 的子串分类、`#371` 的裸 `tauri build` 前置：均为 NIT，非合并阻塞；由各自的 issue 线程承载更合适。
- `#356` 私有交互队列未纳入回收豁免：**必须由 #356 落地时同步处理**（见下）。

## 验证证据（本批修正后）

- `bunx tsc -b` → 0 错（修正前有 TS2741/TS2345 6 处、TS2322/TS6133 各 1 处）
- `bunx vitest run` → **5041 passed / 0 failed / 1 skipped / 1 todo**（657 文件）
- `bunx eslint src/` → **0 error**（另 1 条 warning，不触发门禁）。当时两处 `Parsing error` 属他人在途未提交文件（`src/domains/workbench/terminalSnapshot.ts`、`.../content/contentPartSchema.ts` 正在改），已排除并确认与本 PR 已提交内容无关
- clippy 基线门禁（照 CI 逐 crate 跑 `scripts/check-clippy-baseline.mjs`）→ pylon / pylon-core / pylon-acp / pylon-session / pylon-foundations / pet-core **全 OK**（`added: []`）
- `cargo test --workspace --lib` → **1534 passed / 0 failed / exit 0**
- 定向：`cargo test --lib session_expiry` → 13 passed（含新增保活用例）

## 未解问题

1. **CI 未能本地复现**：本机无法跑完整 `check:frontend`（含 `build`/`check:bundle`/`build:solid-smoke` 等）与 Windows CI 环境；上表是逐门禁等价命令的读数。权威判定仍是 PR 的 CI 结果。
2. **`#356` 落地后必须回看 `session/expiry.rs`**：其私有交互队列（`PrivateInteractionOwner`）与 `runtime.interactions` 是**两个**队列；本 PR 的豁免只认后者，且本 PR 的连接级回收在 `Disconnected` 上不自愈。作者已在 `L.md` 声明该交接点。
3. **共享 index 的 stale 化**：见下「共享树观测」。

## 共享树观测（给后续施工者）

1. **共享 index 会变 stale**：本批与其它 agent 都使用了私有 index 提交（`commit-tree` + `update-ref`）以避免连带他人改动，副作用是 HEAD 前移而共享 index 不动——此时 `git diff --cached` 会把别人已提交的内容显示成「已暂存的反向改动」，任何**不带 pathspec** 的 `git commit` 会把这些改动回退掉。本次观测到 11 个文件处于该状态（逐条核对为纯 stale：全部是「index 比 HEAD 旧」的形态，无任何人为暂存内容），已用 `git read-tree HEAD`（**只写 index、不碰工作树**）复位，`git diff --cached` 归零。
   - 判别方法：`git diff --cached --numstat` 若全是「0 增 / N 删」或与近期提交反向，即为 stale；真正暂存会带新增行。
   - 已在 `L.md` 留痕。
2. **多处「同一处修正被两个人同时做」**：本轮 3 个测试双件 + 1 处导入 + 1 处 TS 收窄，我与原作者各自独立改到同一处，最终由对方的提交入库（内容一致）。这不是浪费——共享树上「谁先落地算谁」是常态，代价是提交信息里的归属会归到先提交者。记录在此以免后人误判。
3. **提交信息里的反引号**：`git commit -m "..."` 用双引号时反引号会被 shell 当命令替换（本次 `088a5096` 因此丢了一个词）。含反引号的信息请用 `-F`/`--file` 或单引号。
