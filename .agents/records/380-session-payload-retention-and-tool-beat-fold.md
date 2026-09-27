# Dev Record — #380 会话级载荷常驻（`fold.log` 退场）+ 工具拍折叠（方案 v2）

> 入库保留。承接 #375 的剩余两刀（调查与 #375 主批见 `375-376-memory-payload-amplification.md`）。

## 元信息

- issue：**#380**（refactor/perf：#375 剩余三项）
- 分支：`kumo/prometheus`
- 提交范围：`ced0cb78..`（本 issue 的提交）
- 日期：2026-09-27
- 前置裁决（仓库主）：「两项都放行」——①允许折叠方案版本化以扩展工具拍折叠；②允许 `fold.log`
  只留 `eventId` 并把 reject 回滚改成按需从 journal 重读。

## 目标与范围

**目标**：把会话级（文档 + 回滚日志）的载荷常驻与拍数敏感性收掉——#375 主批只解决了**文档口径**
（0.235× / 1.34×），会话口径仍 ≈1.4× / ≈6.8×，缺口全在 `fold.log`。

**做到**：
1. **`fold.log` 整份删除**（原计划「只留 eventId」，实测该结构唯一消费者是回滚，见下）；
2. 被拒回滚改走 **canonical 重读重建**（`refresh(..., { rebuild: true })`），回滚所需的权威源回到 journal；
3. **工具拍折叠（方案 v2）**：同一 `toolCallId` 的**累积式**连续 `tool.call.updated` 压成 `tool-run` 段；
4. L3 裁剪**按单元记录的方案**重折（方案换版不得让旧单元永远 mismatch）。

**不做什么**：不动 `turn.unit` 的既有段形与事件类型（只**追加** `tool-run` 段，由 `foldScheme` 版本化）；
不改渲染视觉与交互；不引入新事件类型；不改 `timeline.data` 收窄口径（K20 已定档）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | 删 `fold.log`/`fold.ids` 与全部清空点；`refresh` 增 `rebuild` 选项；接线 `reloadFromJournal` | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchOptimisticEcho.ts` | `reject` 改异步：不再整页重折内存日志，改请宿主重读；删 `fold` 依赖与 `AgentWorkbenchFoldState` | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchProjection.ts` | 删 `withoutEnvelopeRaw`（其唯一调用点是已删除的日志） | 删除导出 |
| `src/sheets/agent-workbench/agentWorkbenchCommands.ts` | `rejectOptimisticDocument` 返回 `void \| Promise<void>`，`send` 的 catch 里 await 它 | 修改 |
| `src-tauri/pylon-session/src/turn_rollup.rs` | 方案常量 v2 + `TOOL_RUN` 段 + `tool_run_at`（累积前缀判据）+ `fold_turn_rows_with_scheme` | 修改 |
| `src-tauri/pylon-session/src/event_repo/repo.rs` | L3 裁剪按单元的 `foldScheme` 重折 | 修改 |
| `src/domains/events/canonicalUnit.ts` | `tool-run` 段的解析与展开（展开＝末拍那一行） | 修改 |
| 测试：`agentWorkbenchSession.test.ts`、`timelinePayloadNarrowing.test.ts`、`canonicalUnit.test.ts`、`turn_rollup.rs`、`event_repo/tests.rs` | 见「测试处置」 | 修改 + 新增 |
| `docs/说明书/Pylon-项目架构参考.md`、`scripts/perf-bench/README.md` | 段形/方案/裁剪口径与「会话口径」措辞同步 | 修改 |

## 方案要点

### 1. `fold.log` 为什么是**删**而不是「只留 eventId」

原计划的措辞是「日志只留 eventId」，落点勘察后发现：它的**唯一**消费者是
`agentWorkbenchOptimisticEcho.reject`，用法是按**信封引用同一性**过滤后整页重折
（`fold.log.filter(item => item !== rejected.envelope)`）。要重折就得有完整信封，而信封的载荷
正是要省掉的那份——所以「只留 eventId」在与同步回滚并存时不可实现。仓库主放行后改为：
**回滚的权威源回到 journal**（它本来就是权威），日志整份删除。

### 2. 回滚走 `refresh(rebuild: true)`，语义与代价如实记

- 复用 bind/refresh 那条发布路径：epoch/generation 守卫、`binding.buffered` 覆盖读期间到达的
  live 行、`withPending` 补折**仍 pending** 的乐观行——被拒那条已从 pending 移除，自然不在结果里。
- **`rebuild` 是必需的**：缺省 refresh 是**续折**（以当前文档为 base），乐观行会原样留在文档里。
  代码里早有这条注释（"冷装载（bind）与回滚重折必须显式传新的空文档"），本次把它落实成显式开关。
  *本 issue 施工中先漏了这点，被既有用例当场抓红，才补上的。*
- 代价两条（如实登记）：①时间上是**异步**的（`send` 命令 await 它，「返回时已撤销」的时序不变；
  其它调用方 fire-and-forget）；②重建视角以 journal 为准——sink debounce 窗口内尚未落盘的 live 行
  按既有 refresh 语义处理（读期间到达的行由 `buffered` 覆盖），不属本次重建的由下次 canonical 读回补。

### 3. 工具拍折叠只折**可证无损**的 run

- 判据：相邻、sequence 连续、同 `toolCallId`，且**后一拍正文以前一拍正文为前缀**（累积式回传）。
  满足时末拍在投影上完全取代中间拍，压缩**不改变任何可见内容**；不满足（增量式回传）一拍都不折，
  行原样保留为 `event` 段 ⇒ 不存在「为了让 journal 变小而丢用户可见内容」的风险。
- 段形：`{ kind: "tool-run", eventType, seqStart, seqEnd, foldedCount, occurredAt, identity, event }`，
  `event` 是**末拍的整行 EVT-01 事件**；读侧展开即那一行（不新造形状）。
- **方案版本化**：`TURN_UNIT_FOLD_SCHEME = "adjacent-delta-fold-v2"`，v1 保留为常量并在
  `fold_turn_rows_with_scheme` 里可选；L3 裁剪从单元自己的 `foldScheme` 取值重折——否则旧单元
  会永远 `ShaMismatch`（保行、永久跳过 = 迁移停摆）。未知方案 ⇒ 空 sha ⇒ 必然 mismatch ⇒ 保行不误删。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 会话侧不再持有整会话信封（`fold.log`/`fold.ids` 不复活） | PASS（源码守卫用例 `.agents`…见测试处置；`agentWorkbenchSession.ts` 内零命中） |
| 回滚的权威源是 journal（不是内存日志） | PASS（新用例：回滚把**只有 journal 里有**的 assistant 行带了回来，且 `loadAll` 被再次调用） |
| 回滚后文档无乐观行、时钟不复活（既有契约） | PASS（既有 3 条用例**未改**即通过） |
| `send()` 返回时「已撤销」的时序 | PASS（`send` 的 catch 里 await 回滚；既有用例的同步断言未改） |
| 累积式工具拍折成一段（`foldedCount`/跨度/末拍事件） | PASS（Rust 用例 4 条） |
| 增量式工具拍一拍都不折 | PASS（`non_cumulative_tool_beats_are_not_folded`） |
| 单拍 / 换 `toolCallId` / sequence 不连续 一律断开 | PASS（`tool_run_breaks_on_identity_gap_or_single_beat`） |
| v1 单元按 v1 重折可裁剪；记 v1 却持 v2 的 sha ⇒ mismatch 保行 | PASS（`rollup_trim_refolds_with_the_scheme_recorded_on_the_unit`） |
| 前端 `tool-run` 展开为末拍行（**消息侧** `expandTurnUnitRows`） | PASS（`canonicalUnit.test.ts` 新增 2 条，含形状防御：`foldedCount < 2` / 缺末拍事件判不可解析） |
| 前端 `tool-run` 展开（**工作台侧** `expandCanonicalUnitRow`，经 `canonicalRowToWorkbench`） | 初版**漏做**（评审阻塞项）→ 已修：见「评审轮」；新增 `agentWorkbenchSession.batch.test.ts` 用例断言工具活动与逐拍路径逐字段相同、且不产出幽灵 reasoning 行 |
| 全量类型检查（`tsc -p tsconfig.json` / `build` 的 `tsc -b`） | 初版**红**（评审阻塞项）→ 已修（`tsc -p tsconfig.json --noEmit` exit 0） |
| 既有门禁 | 见「证据」一节 |

## 测试处置

- **新增**：
  - `src/sheets/agent-workbench/__tests__/agentWorkbenchSession.test.ts`：`#380：被拒回滚的权威源是
    journal——重读会把期间落盘的行一并带回来`（区分性用例：修前这条必红，因为旧实现只用内存日志重折）。
  - `src/domains/workbench/__tests__/timelinePayloadNarrowing.test.ts`：把 `#375-c` 的
    `withoutEnvelopeRaw` 单测与「入日志走 helper」接线守卫**替换**为 `#380` 的两条守卫
    （①会话里不存在 `fold.log`/`fold.ids` 的代码形态；②回滚必须显式 `await reloadFromJournal()`
    且会话侧确实接线）。
  - `src-tauri/pylon-session/src/turn_rollup.rs`：5 条（累积折叠 / 非累积不折 / 断 run 三态 /
    方案差异与未知方案 / v1 重折确定性）。
  - `src-tauri/pylon-session/src/event_repo/tests.rs`：1 条（裁剪按单元记录的方案重折）。
  - `src/__tests__/replay/canonicalUnit.test.ts`：2 条（tool-run 展开等价 + 形状防御）。
- **修改**：无（既有回滚用例在新语义下**未经修改**即通过——`void | Promise<void>` 的签名放宽
  与 `send` 的 await 保住了「返回时已撤销」的既有断言）。
- **删除**：`withoutEnvelopeRaw` 及其 2 条用例（随 `fold.log` 退场而失去意义）。

## 证据

- commit：`<见 git log：perf(#380) …>`（改动清单内文件按 pathspec 提交）
- 测试与门禁（全部本机实跑）：
  - `cargo test -p pylon-session --lib` → **177 passed / 0 failed**（本批 +6）
  - `bun run test` → **656 文件 / 5044 passed、1 skipped、1 todo，0 failed**
  - `bun run check:solid` → **exit 0**（运行时边界「32 条遗留白名单仅报告；无新增越界」、
    CSS 消费审计 / ZONE_FIELDS / 插件 allowlist / hook 锚点对齐逐项通过）
  - `bun run check:rust` → **exit 0**（`CARGO_INCREMENTAL=0`；含 fmt 检查与各 crate lib 测试）
  - `bun run check:clippy` → **exit 0**（基线 diff：added/removed/reduced 全空）
  - ⚠️ 两次中途红灯都**不是**本次改动：①`pylon-core::agent_detection` 两条用例（文件占用 +
    2 秒墙钟预算）在本机并发构建/后台审核压测下偶发，单独复跑 3/3 通过，且本批未触 `pylon-core`；
    ②`G:` 盘满（`os error 112`）导致编译中断——删掉可再生的 `target/debug/incremental` 与
    `target/release` 缓存后，以 `CARGO_INCREMENTAL=0` 重跑全绿。**G: 盘长期只剩 0–3 GB，
    这是共享工作树上的系统性问题**，建议后续把 target 目录移出 G: 或定期清缓存。
- 手工/结构证据：`agentWorkbenchSession.ts` 与 `agentWorkbenchOptimisticEcho.ts` 内 `fold.log`/`fold.ids`
  零命中（守卫用例断言的是**代码形态**正则，注释里提到名字不算违规）。

## 与 spec 的偏差

- 原计划「`fold.log` 只留 `eventId`」→ 实际为**整份删除 + 回滚走重读**。理由见「方案要点 1」；
  这是仓库主放行后的更彻底做法，收益即会话口径的乘法因子归零。
- 原计划「工具拍折叠」未规定安全性判据 → 实际加了一条**累积前缀判据**（只折可证无损的 run）。
  理由是「中间拍只留最后一拍」对增量式回传的 provider 会丢可见内容，而本机没有累计式 provider
  的样本可证（记录 §7 的诚实标注）；加判据后压缩要么无损、要么不发生。
- **会话级比值读数未产出**：perf-bench 的 memory 域是**纯函数文档口径**，不建模会话宿主。
  `fold.log` 删除后会话侧只剩「文档 + 有界 pending」，这是**结构性事实**（由源码守卫 + 回滚行为
  用例钉住），不是探针量出来的——如实登记，不拿文档读数冒充会话读数。

## 未解问题

1. 工具拍折叠**在本机无可证的 provider 样本**（Hermes 不经 `tool_call_update` 回传工具输出）。
   `tool-run` 的收益（journal/unit 字节、compact 读下行数）要等真实累计式 provider 的会话才能取数。
2. `refresh(rebuild: true)` 的 live 行窗口（见方案要点 2 的代价②）沿用既有 refresh 语义，未额外加固；
   若后续发现「reject 恰逢未落盘 live 行」的可见回跳，可考虑把 `binding.buffered` 之外再留一个
   极短的尾部缓冲（有界）。

---

## 评审轮（独立子 agent，对抗式）与处置

评审任务：把本次改动**证伪**（回滚正确性/异步化对调用方的影响、折叠安全性、方案版本化与 L3 裁剪、
前端展开等价、测试是否恒真、门禁与记录诚实度）。总判 **REQUEST CHANGES**——两个阻塞项都是真的，
已全部修复并补了会失败的回归测试。

### 阻塞项（已修）

1. **全量类型检查红**：`canonicalUnit.ts` 把 `TurnUnitToolRunSegment` 加进联合后，
   `agentWorkbenchProjection.ts` 的 delta-run 分支继续访问 `segment.markdown/text` ⇒ `tsc -b` 挂
   （即 `bun run build` 挂）。**我先前跑的门禁有盲点**：`check:solid` 只覆盖 `tsconfig.solid.json`
   （不含该文件），`bun run test` 走 esbuild 剥类型。→ 已补 `tool-run` 分支修好类型；
   **门禁口径改为必跑 `bun run build`（`tsc -b`）或 `bun run check:all`**（全量类型检查在
   `check:all → check:frontend → build` 这条链上，本批此前只跑 `check:solid` 才漏掉）。
2. **工作台读路径把 `tool-run` 展开成幽灵行**：`expandCanonicalUnitRow`（会话侧 `canonicalRowToWorkbench`
   的展开点）没有 `tool-run` 分支，压缩段落进 delta-run 兜底 ⇒ 展开出 parts 为空的 `reasoning.delta`
   幽灵信封、**末拍工具事件整行丢失**，等于「同一构建读不回自己写的数据」。而 issue 范围第 1 条
   明写要这条分支。→ 已补分支：末拍整行走既有单行归一，**信封序取 `seqStart`**（活动节点的 placement
   是创建时刻事实，投影器取信封 sequence；用末拍序会让卡片在消息流里跳位），coverage 取整个 run 跨度；
   新增用例 `agentWorkbenchSession.batch.test.ts` 断言工作台侧的工具活动与逐拍路径**逐字段相同**
   （title/status/toolKindWire/displayName/sequence/parts）且 timeline 无 reasoning 行。

### 重要项（已修）

3. **`refreshInFlight` 把 `rebuild` 静默降级为续折**：reject 触发的重建若撞上在途 refresh
   （活跃回合期间 canonical 回放相当频繁），会返回先前那次**续折**的 promise ⇒ 被拒乐观行留在文档里，
   「send 返回时已撤销」在这个窗口里不成立。→ 已改为**排队**：rebuild 请求等在途读落地后再跑一次
   （`refreshInFlight` 那时已清空，递归调用走新读）。新增行为用例（`#380：在途 refresh 不会把被拒
   回滚的重建吞掉`），并**实测过去掉排队逻辑即红**（`readCount` 停在 2）。
4. **折叠的「投影等价」前提不成立**（评审给出反例）：投影器的工具节点对
   `title`/`kind`/`semanticKind`/`parentToolUseId`/`canonicalName`/`rawInput`/`name` 走
   `previous?.X` 惰性回退 ⇒ 折成末拍一行后 previous 链消失，**只出现在早期拍的身份/展示字段会丢**；
   另外活动 placement 取首拍序（创建时刻事实），折叠后会变末拍序。→ 已做两件事：
   - **判据加第二维「键集不回缩」**：每一拍的 raw `update` 键集必须是末拍键集的子集（保证末拍自己带全
     这些字段）；正文前缀判据改为**先读 raw**（与投影器读的是同一份 wire）。评审的最小反例
     （beat1 带 title/kind、beat2 省略）现在**直接不折**，已加用例锁住。
   - **placement 修好**：读侧信封序取 `seqStart`（见阻塞项 2）。
   - 记录里「投影器是这些行的纯函数，故投影等价」的注释与用例前提已作废并改写。

### 次要/提示项

5. **未知 `foldScheme` 会被永久标 mismatch**（不误删，但未来换版后旧二进制遇到 v3 单元就出队了）。
   取舍已写进代码注释与本节：**本轮接受**（安全的代价是升级路径要靠 `rollup_migration_state` 手工清）；
   若将来引入 v3，需同时给出「未知方案」的独立状态而不是复用 `mismatch`。
6. 源码守卫的价值与脆弱性：已按建议**收掉整行接线字符串断言**（它测不到合并竞态那一层），
   行为面交给第 3 条的新用例；正则守卫（防信封日志复活）保留。
7. 过时残留已清：`workbenchProjector.ts` 里「fold.log 持有」的注释、`agentWorkbenchSession.test.ts`
   里名为「refresh 后 foldLog 以 journal 权威集替换」的用例名（机制已不存在）。
8. 其它：删掉前端零消费的 `TURN_UNIT_FOLD_SCHEME_V1` 导出（读侧不校验方案字符串，段按 `kind` 展开）；
   live 行窗口的措辞更正为「**sink 1000 ms trailing debounce + 读时长**」（旧实现由 fold.log 保住，
   新实现会先消失约 1 s 再由下一次 canonical 读回补）；`contentSha256` 的
   `serde_json` `preserve_order` 跨构建图差异是 v1 已有的性质，非本批引入，在此登记。
