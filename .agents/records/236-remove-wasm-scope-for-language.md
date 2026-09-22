# Dev Record — #236 删除 wasm `scopeForLanguage` 死出口

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/236（refactor；assignee AlchemistCxC）
- 分支：`Ru5t/Reflector`
- 提交范围：`73e66460`（L.md 开工声明）→ 本轮提交
- 日期：2026-09-22
- 上游：issue #233 的「未接线 wasm 出口 vs 现役实现」测量（用户据其裁定「把死实现落后10倍的项直接删除」）
- 关联：ADR-0018 修订 1（wasm 面收窄）、#220（markdown 切流）

## 目标与范围

用户原话：

> 把死实现落后10倍的项直接删除 剩余的我再考量考量

**做**：删除唯一达到「落后 10 倍」门槛的未接线出口——`pylon-markdown` 的 wasm 导出 `scopeForLanguage`。

**不做**：
- 不动**其他 6 个**未接线导出（三个旧切分出口、两个 `*Json` 编组变体、`markdownEngineVersion`）——用户明确说「剩余的再考量」。它们实测差距都在 0.8–2.5× 之间，够不上门槛。
- 不动 `highlight.rs` 的**内层** `scope_for_language`：`highlight_block` 内部的语言映射要用它（`highlight.rs:200`），Rust 单测也钉着（`highlight.rs:301-306`）。
- 不动现役 TS 表（`src/components/chat/codeHighlight.ts:46`）与它的测试——**行为零变化**是本轮的硬约束。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-markdown/src/wasm_exit.rs` | 删除 wasm 壳 `#[wasm_bindgen(js_name = scopeForLanguage)] pub fn scope_for_language` | 删除 |
| `src-tauri/pylon-markdown/src/highlight.rs` | 内层函数**保留**；只更正它那句指向「TS 侧退役后此处即单源」的过期注释，改写为实测结论 + 正路（代码生成） | 修改（仅注释） |
| `src-tauri/pylon-markdown/parity/dump-ts.mjs` | 更正「vitest parity 测试会经 scopeForLanguage 常驻对齐」——该出口不存在后此说不成立，改为两侧各自单测钉住 | 修改（仅注释） |
| `src/infrastructure/compute/markdownCompute.ts` | 删接口成员 `scopeForLanguage`（一句），并把删除理由写进相邻注释 | 修改 |
| `scripts/perf-bench/index.ts` | `EXCLUDED_WASM_EXITS` 移除该条（6 条），计数注释同步 | 修改 |
| `scripts/perf-bench/README.md`、`scripts/perf-bench/suites/markdownHighlightSuite.ts` | 未接线计数 7→6 与说明同步 | 修改（文档） |
| `.agents/decisions/0019-*.md`、`.agents/records/233-*.md` | 未接线计数与交叉引用同步 | 修改（文档） |
| `src/wasm/pylon-markdown/*` | 重建产物（gitignore 内，不入库） | 重建 |
| `.agents/L.md` | 开工声明 | 修改（已单独提交 `73e66460`） |

## 方案要点

1. **删壳不删内层**：wasm 壳（`Option<String>` 过界）与内层（`Option<&'static str>`，供 `highlight_block` 内部映射）是两件事——前者零调用方且慢，后者有内部消费者且被单测钉住。删错一个就会把高亮打坏。
2. **行为零变化的判据**：现役 TS 表与 `codeHighlight.test.ts` 一字未改（20 例原样通过）；产品路径（`highlightCodeBuiltin`）根本不经过这个 wasm 出口，所以删除不可能改变行为。
3. **更正两处会误导后人的注释**（AGENTS §6.2）：
   - `highlight.rs` 原注释说「两边各写一份是暂时的（TS 侧退役后此处即单源）」——本轮实测说明**这条路线不可行**：经 wasm 出口查表比 TS 查表慢约 18×（每调用过界 + 编 JS 串）。正路是**代码生成**（本仓既有先例 `scripts/generate-canonical-event-types.mjs` 从 `pylon-canonical-types` 生成 TS 词表）。
   - `dump-ts.mjs` 原注释说语言映射漂移「vitest parity 测试会经 scopeForLanguage 常驻对齐」——实测无任何测试引用 wasm 该出口；实际是两侧各自单测钉到同表期望值（Rust `highlight.rs:301` 与 TS `codeHighlight.test.ts:20`）。
4. **如实标注量级**：18× 是「实现 vs 实现」的逐次调用比；生产里 `scopeForLanguage` **每个代码块只调一次**（`codeHighlight.ts:89`），所以绝对代价约 **0.85µs/代码块**，不是热路径问题。删除的正当理由是「死面 + 同表两份 + 更慢」，不是救火。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| wasm 壳已删、产物里不再有该导出 | ✅ `pylon_markdown.d.ts` 导出剩 5 个（`highlightBlock` / `highlightBlockJson` / `markdownEngineVersion` / `parseMarkdown` / `parseMarkdownJson`）+ `initSync`，`grep scopeForLanguage` 无命中 |
| 内层函数与 Rust 单测保留 | ✅ `cargo test -p pylon-markdown --lib` → **32 passed; 0 failed**（含 `scope_mapping_matches_ts_baseline`） |
| 现役 TS 表与测试一字未改 | ✅ `vitest run src/components/chat/__tests__/codeHighlight.test.ts` → **20 passed** |
| `tsc -b` | ✅ exit 0 |
| `lint` | ✅ 0 error / 1 warning（`RightRailHost.tsx:39`，既存） |
| parity 门禁未受影响 | ✅ `vitest run scripts/compute-parity.test.mts` → 1 文件 / 2 用例通过（该门禁只覆盖 `pylon-compute`） |
| 基准仍可跑且排除清单为 6 条 | ✅ `PERF_SCALE=xs bun scripts/perf-bench.mts` exit 0 |
| `cargo fmt --all --check` | ✅ exit 0 |
| clippy | ✅ 触碰文件（`wasm_exit.rs`）**0 条**警告；`pylon-markdown` 其余 7 条在 `theme.rs`/`highlight.rs`/`tm_language.rs`，均为既存且不在基线门禁覆盖内（见未解问题 2） |
| 产物体积 | ✅ `pylon_markdown_bg.wasm` **2,873,113 → 2,872,825 B raw**（−288 B）/ gzip **909,560 → 908,885 B**（−675 B）；`check:bundle` PASS（总 wasm gzip 963,153 → **962,478**） |

## 测试处置

- 新增测试：**无**（纯删除 + 注释，无新契约）。
- 修改/删除既有行为测试：**无**。逐个点名需保全的：`src/components/chat/__tests__/codeHighlight.test.ts`（TS 映射表 20 例，原样通过）、`src-tauri/pylon-markdown/src/highlight.rs` 的 `scope_mapping_matches_ts_baseline`（内层表，原样通过）。

## 证据

- 提交：本轮提交（见 PR #235）。
- 测试：`cargo test -p pylon-markdown --lib` 32 passed；`vitest run src/components/chat/__tests__/codeHighlight.test.ts` 20 passed；`vitest run scripts/compute-parity.test.mts` 通过；`tsc -b` / `eslint src/` / `bun run build` / `check:bundle` / `cargo fmt --check` 均 exit 0。
- 手工核：重建后 `src/wasm/pylon-markdown/pylon_markdown.d.ts` 的导出清单（见验收表第 1 行）。

## 与 spec 的偏差

1. **未写 spec**：本轮是「用户裁定 + 上轮实测」直接得出的十行级删除，判定依据（门槛、18× 读数、内层/壳的区分）已在 issue #236 正文里写全，另立一次性 spec 只是抄一遍。规格化的目标与验收并入本文档。

## 未解问题

1. **其余 6 个未接线导出等用户考量**（用户原话「剩余的再考量」）。其中 4 个（三个旧切分出口 + 两个 `*Json`）实测差距 0.8–2.5×，够不上「落后 10 倍」；`markdownEngineVersion` 无对照物、无法用该规则评估。若要清，走的是「删死面 / 纯体积与维护面」的理由，而不是「换实现」。
2. **clippy 基线门禁不覆盖 `pylon-markdown`**：`artifacts/clippy-baseline.json` 的 `crates` 只有 `pylon` 与 `pylon-core`，CI 的循环也只检查那 4 个 spec。该 crate 现有 7 条警告因此**无人拦**（本轮未新增，但这是个既存的覆盖缺口）。属独立问题，本轮只登记。
3. **单一来源仍未达成**：语言表在 Rust（`highlight.rs:62`）与 TS（`codeHighlight.ts:15`）各一份。本轮只删掉了那条「用 wasm 出口收敛」的错路，正路（代码生成）需要单独立项。

## 并行交集

- `src-tauri/pylon-markdown/src/{wasm_exit.rs,highlight.rs}` 与 `parity/dump-ts.mjs`：本轮唯一触碰的 Rust 面。
- `src/infrastructure/compute/markdownCompute.ts`：删一句接口成员（`MarkdownCompute` 契约收窄）。
- `scripts/perf-bench/**`：计数与注释同步。
- 未触碰：`src/components/chat/codeHighlight.ts`（现役 TS 表）、`src-tauri/pylon-compute/**`、`src-tauri/pylon-markdown/src/parser.rs` 等高亮/解析内层。
