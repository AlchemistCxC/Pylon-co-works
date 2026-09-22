# Dev Record — #241 高亮引擎改 Lezer（刀1~刀5 已落地）

> 入库保留。规格（一次性）见 `.agents/spec/241-lezer-highlight-migration.md`。
> **本条为阶段记录**：刀 1（引擎并行落地）、刀 2（切流 + 实机验收）、刀 3（退役 wasm 高亮）、
> 刀 4（说明书 + ADR-0018 修订）、刀 5（基准跑出的截断缺陷修复）均已完成，待合入。

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/241（refactor；用户拍板「选C，开工」）
- 路线决策：[`ADR-0020`](../decisions/0020-highlight-engine-lezer.md)
- 分支：`Ru5t/Reflector`；提交：`27a53f4a`（刀1）、`b5f5cf7b`（刀2）、刀3 见下方「证据」
- 日期：2026-09-22

## 目标与范围

高亮引擎从 Rust/wasm（syntect + vendored tmLanguage）改为 **Lezer**（纯 JS，与应用里的文件编辑器同一套引擎）。依据：`#240` 的定位（语法资产占渲染器可控内存 ~30% 且**不可归还**）+ 本轮引擎对比 spike（内存/延迟/覆盖/掉色四表，见 #241）。

**用户两条裁定**：① 引擎 = Lezer（不是 Prism、不是 starry-night）；② 类名映射「**全重写，不保 TextMate 保真度**」。

## 改动清单

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `src/components/chat/lezerHighlight.ts` | 语言别名同步门（`LANGUAGE_HINTS`）、懒装载引擎、`TAG_TO_CLASS` 表、整块进/行数组出 | **新增**（刀1） |
| `src/components/chat/codeHighlight.ts` | builtin 换引擎；语言门换判据；`scopeForLanguage` + `LANGUAGE_SCOPES` 退休；编排（缓存/去重/provider/拼 HTML）未动 | 修改（刀2） |
| `src/components/chat/__tests__/codeHighlight.test.ts` | scope 表断言 → 语言门断言；cpp「已知限制」升级为正向断言 | 修改（刀2） |
| `scripts/check-bundle-size.mjs` | 「主应用 chunk」改为从 `index.html` 解析入口 | 修改（刀2，见「门禁修正」） |
| `src-tauri/pylon-markdown/{src/highlight.rs,src/theme.rs,src/tm_language.rs}` | syntect 语法机器、scope→类名主题表、tmLanguage→SyntaxSet 转换层 | **删除**（刀3） |
| `src-tauri/pylon-markdown/assets/{grammars/*,starry-theme.json}`、`gen/generate-assets.mjs` | 14 份 vendored 语法（728KB）+ 主题资产 + 其机械化导出器（输入来自 starry-night） | **删除**（刀3） |
| `src-tauri/pylon-markdown/{Cargo.toml,src/lib.rs,src/wasm_exit.rs}` | 摘 syntect（连带 `fancy-regex`/`yaml-load`）依赖；模块表只剩 `model`/`parser`/`wasm_exit`；删 `highlightBlock`/`highlightBlockJson` 两个出口 | 修改（刀3） |
| `src-tauri/pylon-markdown/src/bin/parity_snapshot.rs`、`parity/corpus.json`、`parity/rust-snapshot.json` | 快照 bin 只导 markdown；语料摘掉 highlight 组（12 条）；快照重生成（117 条，顶层 key 只剩 `generator`/`markdown`） | 修改（刀3） |
| `src-tauri/pylon-markdown/parity/{dump-ts.mjs,diff.mjs,ts-baseline.json,parity-report.json}`、`src/components/chat/starryCore.ts` | TS↔Rust 差分工具与 starry-night 派生的 TS 基线（基线侧已无对照物） | **删除**（刀3） |
| `src/renderers/solid-workbench/chat/__tests__/markdownComputeParity.test.ts` | 重写为**仅 markdown**（117 条对快照深相等）；highlight 半退役 | 修改（刀3） |
| `src/infrastructure/compute/markdownCompute.ts` | 摘掉已死的 `highlightBlock` 成员与 `HighlightSpan`/`HighlightedLine` 类型；头注改为「只做 markdown 解析」 | 修改（刀3） |
| `package.json` | `bun remove @wooorm/starry-night vscode-oniguruma` | 修改（刀3） |
| `scripts/{check-bundle-size.mjs,build-wasm.mjs,audit-maintenance.mts}` | wasm 预算重定标；已退役资产的注释与模块根同步 | 修改（刀3） |
| `scripts/perf-bench/{index.ts,README.md,suites/markdownHighlightSuite.ts}` | 高亮域改量 `highlightBlockWithLezer`（不再触 wasm）；导出记账 11→9、接线 5→4 | 修改（刀3） |
| `src/{store.ts,domains/workbench/workbenchProjector.ts}`、`.../chat/ChatView.css`、两处测试注释 | 仅更正指向已退役引擎的过期表述（§6.2） | 修改（刀3） |

## 方案要点

1. **出口形状与旧 wasm 出口逐项一致**（行数组 / `{ spans }` / 未知语言 `null` / 源码以 `\n` 收尾时少一个空尾行）——这是「换引擎不动消费方」的前提。四个消费面（插件 provider `core.renderer.code-highlight`、聊天代码块、markdown 内嵌代码块、文件只读视图 `FileTabView`）**零改动**，`git diff --stat` 可核。
2. **CodeMirror 全部动态 import**：它们体量不小，静态 import 会进主 chunk。
3. **类名沿用本应用既有的 `pl-*`（palette 已挂在 CSS 的 `--syn-*` 上），把映射按语义重排**；不引入第三方主题包（会绕过 `themeFieldDefs.ts` 的用户可配项、撞主题契约门禁）。

### 类名映射与三档取舍（逐字符差分，parity 语料 12 条）

| 档 | operator | punctuation/bracket | 覆盖率达到 | 掉色 | 多色 | 换色 |
| --- | --- | --- | --- | --- | --- | --- |
| A | ✗ | ✗ | 54.2% | 5.6% | 12.1% | 15.6% |
| B | ✓ | ✗ | 55.7% | 4.5% | 12.4% | 15.6% |
| **C（已取）** | ✓ | ✓ | **69.4%** | **3.3%** | 25.0% | 15.8% |

现状覆盖率 47.7%。A/B 掉的主要是 ts/rust 的 `:`（Lezer 归 punctuation，现状给 `pl-k`）；C 的代价是 css 的 `{`/`;` 也上色。取 C：与现状「算子即关键字色」一致，且不出现「`=` 有色而 `;` 无色」的割裂。想更素只删五行（模块内有注释）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 消费方零改动 | ✅ 生产改动只有 `codeHighlight.ts` + 新模块（`git diff --stat`） |
| 全量 vitest | ✅ **623 文件 / 4678 用例通过**，0 失败 |
| `tsc -b` / `eslint src/` | ✅ exit 0 / 0 error（1 条既存 warning） |
| `check:solid` | ✅ 全过（运行时边界 / CSS 消费 / ZONE_FIELDS / 插件 allowlist / hook 锚点） |
| `check:bundle` | ✅ 全 PASS；总 js gzip **1,459,399 → 1,461,515（+2.1KB）**；高亮引擎 236,660 B 在**懒 chunk** |
| 插件四样契约不动 | ✅ `CodeHighlightProvider` 未动；`scopeForLanguage` 不在插件面上（只被自己与测试引用） |
| **实机：功能** | ✅ 8 个代码块 / **96 个 `pl-*` span**；类名实测含 `pl-c/pl-c1/pl-en/pl-ent/pl-k/pl-s/pl-smi/pl-v` |
| **实机：内存台阶消失** | ✅ 见下表（与上轮**同一探针、同一状态**的 A/B） |
| **实机：首个代码块延迟** | ✅ 切回 8 块会话：首个 span **121.3ms**、整体结算 421.8ms（不再有编译阻塞） |

### 实机 A/B（per-PID 探针，实例 `F:\A-I\Platform\Pylon`）

| 指标（渲染器进程） | 上轮（wasm 引擎） | 本轮（Lezer） |
| --- | --- | --- |
| 装载大会话后 private | **193.4MB** | **107.7MB（−86MB）** |
| css 块入视口的台阶 | **+42.0MB** | — |
| 本次运行 private 峰值 − 基线 | — | **+1.9MB** |

⇒ **刀 2 的核心判据达成**：语法资产那 ~86MB 常驻与「+42MB 不可归还台阶」一起消失，而这一轮 8 个代码块（ts/python/go/css 多语言）都已正常高亮。

### 刀 3 验收（退役 wasm 高亮）

| 验收项 | 结果 |
| --- | --- |
| wasm 产物（glue 之外） | ✅ `pylon_markdown_bg.wasm` **2,872,825 → 428,930 B raw（−85.1%）**；glue 15,783 → 12,469 B |
| wasm 预算（gzip，本门禁口径） | ✅ **962,801 → 198,431 B gzip（−79.4%）**；预算由 1,110,000 **下调**至 230,000（留 16% 余量）。markdown 侧现只剩 comrak 解析（144,838）+ compute 流式核（53,593） |
| js 总量未因 Lezer 失控 | ✅ 总 gzip **1,461,516**（budget 1,615,000，余 9.5%）；Lezer 引擎在懒 chunk 里（`index-*.js` 236,660 B raw / 78,514 B gzip），未进主 chunk（主 chunk 仍 11,178 B） |
| Rust 侧 | ✅ `cargo test -p pylon-markdown --lib` **16 passed**；`cargo clippy -p pylon-markdown --all-targets` 0 警告；`cargo fmt --check` exit 0 |
| 全量 vitest | ✅ **623 文件 / 4673 用例通过**，0 失败（刀2 时 4678——差额正是退役的 highlight parity 半） |
| `tsc -b` / `check:solid` / `check:docs` / `check:deps` / `eslint` | ✅ 全过（eslint 1 条既存 warning，非本改动） |
| 依赖面 | ✅ `starry-night` + `vscode-oniguruma` 已移出 `package.json`；全仓无存活引用（余下命中全在 records/decisions/L.md 的历史记述里） |
| 产品行为 | ✅ 高亮路径不变（仍走 `codeHighlight.ts` → `pl-*`），刀2 已实机验过；本轮是**删除**而非改写，消费方零改动 |

**为什么 markdown 核保留**：`parseMarkdown`（comrak）仍在 wasm——它在同形状对照里是赢的那一半（markdown 流式形 12–25×），且**没有**语法资产那种「编译即常驻、不可归还」的成本。crate 不删。

### 门禁修正（本次改动暴露的歧义）

`check-bundle-size.mjs` 的「主应用 chunk」原先用 `index-*.js` 通配 `find`——本次改动产生了**第二个** `index-*` 懒 chunk（高亮引擎 236,660 B），通配会挑错文件、把懒 chunk 当主应用（读数仍 PASS，但量错了对象）。改为从 `dist/index.html` 解析入口：读数 **11,178 B**（真入口），并已确认高亮引擎在懒 chunk 里（`index.html` 未 preload）。
**注**：此前那个 `112,925` 是在有歧义的通配下读的，故不拿它做逐字对比；可比的量是总 js gzip（+2.1KB）。

## 刀 5（2026-09-22，基准跑出来的缺陷修复）

**来源**：跑 #233 的产品路径基准时读出反常——`markdown-highlight` 域的单位成本随规模**下降**
（`block-4k` 0.592µs/字符 > `block-40k` 0.067µs/字符）。同一份合成料只放大十倍，这个方向不可能成立，
顺着查下去发现的是**功能缺陷**，不是读数噪声。

### 缺陷

CodeMirror 对「不在编辑器视图里的 state」只做**分段同步解析**：`syntaxTree(EditorState.create(...))`
拿到的树停在第一个同步块，本机实测**恒为 3006 字符**。整块一次性高亮这条路径没有视图替它推进解析，
于是超出的部分**静默丢色**。产品路径实测（修前）：

| 输入 | 着色字符 | 首个未着色且非空的行 |
| --- | --- | --- |
| 3,000 | 2,480 | —（截断点落在行内尾段） |
| 3,200 | 2,486 | 第 81 行 |
| 20,000 | 2,486 | 第 81 行 |
| 40,000 | 2,486 | 第 81 行 |

⇒ **超过 ~3k 字符的代码块，第 81 行往后全部失去高亮**。四条消费路径同此：聊天代码块、
markdown 内嵌代码块、插件 provider、**只读文件视图 `FileTabView`**（整文件打开时最严重）。
刀2 的实机验收没照出来，用的是 8 个小代码块（均 <3k）；单测的假高亮引擎也不经过真引擎。

### 修复与验证

- `lezerHighlight.ts`：`syntaxTree(state)` → **`ensureSyntaxTree(state, code.length, FULL_PARSE_BUDGET_MS)`**，
  超时退回部分树。预算 200ms（解析是同步的；实测 40k ≈ 27ms、120k ≈ 46ms，故覆盖到约 45 万字符；
  再大的输入宁可退回部分树也不冻结帧）。真想无上限，正路是保留解析状态做分帧增量（本记录「未解问题 4」）。
- 回归测试：`src/components/chat/__tests__/codeHighlight.test.ts` 新增「大块整段着色」两条
  （6k / 20k 的 ts 块，**末段必须有 `pl-*`**——截断的特征正是后半段标记数为 0，总数断言会在
  「抬高截断点」的实现下假绿）。**红→绿已验**：还原修复后这 2 条红、其余 20 条绿；带修复 22 条全绿。
- 修后产品路径：40k 输入 → 着色 33,070 字符，无未着色非空行。

### 修掉截断后的真实成本（同机，Bun/JSC）

高亮成本 ≈ **1.6ms 固定 + 0.465µs/字符**：4k 4.43ms / 12k 6.37ms / 40k 19.82ms / 200k 91.02ms
（单位成本 4k 1.108、12k 0.531、40k 0.495、200k 0.455µs/字符）。基准 `full` 档重跑：
`block-40k` **20.53ms**、`block-200k` **87.42ms**（修前两者都在 ~2.7ms —— 因为都只算了 3006 字符）。

**连带更正 ADR-0020**：本 ADR 与对比 spike 里 Lezer 那侧的**延迟**读数（「4KB 1.13ms」「99.6ms → 1.13ms ≈90×」）
同样是被截断的量；决策由内存驱动（不受影响），但延迟栏已更正（见该 ADR 修订 1）。

### 顺带的基准口径修正（#233）

该域固定开销（~1.6ms/次）是 wasm 出口（5–30µs/次）的约 50 倍，而全局单位成本门槛 32 字符照 wasm 定的
⇒ 小语料行会印出「4.78µs/字符」这类由固定开销除出来的假读数。`PerfPair.minUnitsForUnitCost`
改为可按 pair 声明，高亮域自报 **16000**（实测固定开销摊到 ≤20% 的规模）；表头与 README 同步说明。

### 刀 5 的门禁

| 门禁 | 结果 |
| --- | --- |
| 定向 vitest（`codeHighlight.test.ts`） | ✅ **22 passed**（含新增 2 条）；**红→绿已验**：去掉修复时这 2 条红、其余 20 绿 |
| 全量 vitest | ✅ **623 文件 / 4675 用例通过**，0 失败（刀3 时 4673，+2 = 新增回归两条） |
| `tsc -b` / `check:solid` / `check:bundle` / `eslint` | ✅ 全 exit 0（wasm 198,431 / 230,000 不变；eslint 1 条既存 warning 非本改动） |
| 基准 | ✅ m 档与 full 档均跑通；修后读数见上（`block-40k` 20.53ms、`block-200k` 87.42ms） |

## 刀 6（2026-09-22，用户「现在做」）：解析按时间切片 + 片间让出——消掉最后一个静默降级

刀5 把「>3k 丢色」修成「整段解析」，但留下一个尾巴：解析是**同步**的，用 200ms 预算兜住，
**超过预算（约 45 万字符）仍退回部分树——静默降级依然是降级**。这一刀把它做掉。

### 排掉的三个不可行路径（都是实测，不是推断）

| 路径 | 实测结果 |
| --- | --- |
| `ensureSyntaxTree(state, len, 小预算)` 反复调用，逐片抬高 | **不累积**：每片烧掉整个预算、树长不动（400k 文档 20 片全是 3001 字符）。该函数每次 `updateViewport` 并还原，推进被丢弃 |
| 直接驱动 `state.field(Language.state).context.work(ms, upto)` | **能累积**（`parsedPos` 每片涨 1–2 万，22 片走完全文），但 `work` / `isDone` / `tree` **不在 `ParseContext` 的公开声明里**（只有 `state`/`fragments`/`viewport`/`skipUntilInView`），要伸进内部 |
| `parser.startParse(code, 上一棵树作 fragment)` + `TreeFragment.addTree` | **抛异常**（`FragmentCursor.nodeAt` 读 undefined）：ranged/fragmented 复用的前置条件不满足 |

### 采纳的形状（只用 Lezer 公开 API）

`Parser.startParse(code, [])` 得到 `PartialParse`，**空转 `advance()` 直到它返回树**——`advance()`
每次只推进约 1µs，未完成时返回 `null`，所以「攒够一个时间片就让出」是自然的：

```ts
const parse = parser.startParse(code, [])
let sliceStartedAt = now()
for (;;) {
  const tree = parse.advance()
  if (tree !== null) return tree
  if (now() - sliceStartedAt >= PARSE_SLICE_MS) { await yieldToEventLoop(); sliceStartedAt = now() }
}
```

CodeMirror 自己就是这么驱动它的空闲解析（`while (!(tree = parse.advance())) {}`）。
等价性：与走 `Language` machinery（`EditorState` + `ensureSyntaxTree`）的结果**逐区间完全一致**
（ts 9888 符文 / html 529 符文，含 html 的嵌套语言——html 是唯一有 `parseMixed` 的受支持语言，
故用它做等价性判据最严）。根因也清楚：CM 的 `Language.state` 内部用的就是同一个
`support.language.parser.startParse`。

让出实现按运行时能力择一：`scheduler.yield()`（Chromium 129+，WebView2 153 有）→ `MessageChannel`
（无 `setTimeout` 的 4ms 嵌套钳制）→ `setTimeout(0)`（jsdom 兜底）。

### 顺带砍掉两块固定开销

1. **去 `EditorState`**：解析改走 `support.language.parser` 后不再需要 state，随之去掉每次调用的
   `@codemirror/state` / `@codemirror/language` 运行时 import。
2. **去掉重复解析**：旧路径里 `EditorState` 的 `Language.state` 字段初始化会先同步解析一个块
   （3006 字符），随后 `ensureSyntaxTree` 为了到 4000 又从头解析一遍 ⇒ **前 3006 字符解析两遍**。
   单次 `startParse` 只解析一遍。
3. `highlightTree` 与 `tags` 同在 `@lezer/highlight`，并入引擎缓存，不再每次动态 import。

### 效果（同机，Bun/JSC）

| 规模 | 刀5（`ensureSyntaxTree`，200ms 预算） | 刀6（切片驱动） |
| --- | --- | --- |
| 4,000 字符 | 4.43ms | **2.05ms** |
| 12,000 | 6.37ms | **4.71ms** |
| 40,000 | 19.82ms | **17.22ms** |
| 200,000 | 91.02ms | **76.23ms** |
| 500,000 | **201ms 后截断到 3001 字符**（冻结与丢色同时发生） | **235ms 全解析**（切片让出，无帧独占） |

基准 m 档：`block-4k` 4.50→**2.84ms**、`block-40k` 18.31→**16.28ms**（0.407µs/字符）；
`markdown-highlight` 域 Σ 25.05→**20.50ms**。js 总 gzip 1,461,516→**1,458,799**（−2.7KB）。
切片总开销与一次性 `parse()` 同量级（400k：197ms vs 183ms，+7%）。

### 测试（新增 4 条，全部用**注入**而非计时抖动）

| 用例 | 判据 |
| --- | --- |
| 把分片预算压到 1ms（60k 必然超出） | 让出次数 > 0（切片路径确实走到）且**末段仍有色** |
| 500k 的块 | 整段有色——这条对刀5 是红的（刀5 在 201ms 后停在 3001 字符） |
| 小区块（19 字符） | 让出**零次**——不给小输入加成本（先热身一次以排除首调装载） |
| 注入让出 vs 默认路径 | 产出逐行相等（让出不影响结果） |

定向 `codeHighlight.test.ts` **26 passed**；全量 vitest **623 文件 / 4679 用例通过**，0 失败。
`tsc -b` / `check:solid` / `check:bundle` / `eslint` 全 exit 0。

### 代价与边界

- **不设总量上限**：切片只限制「单次不让出多久」，总量随规模线性增长（1MB ≈ 0.47s，但分摊到帧）。
  这是有意的：回到任何形式的「算一半」就是回到静默降级。
- 让出把作业拉长到跨帧，`codeBlockDomLifecycle.ts` 的 8ms 帧预算调度器因此改口径（见该模块注释：
  它继续管**作业顺序**，帧内让出交给引擎）。
- **不做解析状态复用**（每次调用从零解析）：曾写成待办项，经核查是错的——产品路径不会对增长中的
  同一段文本反复调用引擎（未闭合围栏不高亮、闭合块每实例一次、结果缓存 128 条），详见「未解问题 5」。

## 测试处置

- 修改：`src/components/chat/__tests__/codeHighlight.test.ts` —— ① `scopeForLanguage` 表断言（3 条：2 条别名表 + 1 条未知语言）改为 `hasHighlightLanguage` 断言（等价判据，别名集合不变）；② **cpp 的「已知限制」升级为正向断言**（旧实现每语法独立 SyntaxSet ⇒ cpp 顶层 include 的 source.c 未注册 ⇒ 静默零分词；Lezer 的 lang-cpp 自带基础语法 ⇒ 现在真的着色）。这正是 ADR-0020 记的**有意分叉**。
- 修改（刀3）：`src/renderers/solid-workbench/chat/__tests__/markdownComputeParity.test.ts` —— **重写为仅 markdown**：删掉 `GRAMMAR_LOADERS`/`highlightHast`/`flattenTsTokens`/`flattenRustLines`/`report` 与 starry-night 装载，保留 script-run 快照/语料覆盖断言 + 「全部 117 条 case 与 `rust-snapshot.json` 深相等」。**这是契约变更型修改**：被删的一半所对照的两侧（TS 基线 `ts-baseline.json` 与 wasm `highlightBlock`）都已退役，门禁无可对照物。
- 新增（刀5）：`src/components/chat/__tests__/codeHighlight.test.ts` 的「大块整段着色（回归：同步解析上限截断）」两条（6k / 20k ts 块，末段必须有 `pl-*`）。判据选「末段有色」而非「总色数」：截断的特征恰是后半段标记数为 0，总数断言在「抬高截断点」的实现下会假绿。
- 新增（刀6）：同文件「解析切片：不截断、片间让出」四条——1ms 预算下 60k 仍整段有色且确实让出、500k 整段有色（对刀5 为红）、小区块零让出、注入让出与默认路径结果逐行相等。
- 未修改但已复核：`FileTabView.readonly`（2 处 `pl-*`）、`issue221.codeBlockLifecycle`（1 处）在切流后**原样通过**。

## 证据

- 提交：`27a53f4a`、`b5f5cf7b`（已推送 `github/Ru5t/Reflector`）；刀 3 见本条所在提交。
- 差分脚手架：`.agents/spec/241-lezer-diff.mts`（不入库；口径为逐字符 lost/gained/changed + 覆盖率）。
- 实机：新构建 `pylon-0.2.6-Abc-win64.zip`（14:57，242 项 verify OK）装入实例；`data/pylon-data-v1.sqlite3` 与 `agents.yaml` 的 md5 替换前后一致（`md5sum -c` OK）；MCP 七步自检通过；per-PID 探针 30 轮。
- 刀3 体积重测：`node scripts/build-wasm.mjs` + `bun run build` + `bun scripts/check-bundle-size.mjs`（输出见上表，全 PASS）；`bun scripts/perf-bench.mts`（`PERF_SCALE=xs`）跑通，`markdown-highlight` 域 9 case 全绿且「核线性Δ」列恒为 0（预期：本域不再触 wasm）。

## 与 spec 的偏差

1. spec 说「CSS 零改动」——**成立**（新引擎继续产 `pl-*`，颜色定义未动）✓。
2. spec 的「并排渲染比对」这一步**未做**：三档逐字符差分给了等价依据，且用户已直接裁定取 C 档。若后续觉得观感需要，再补。
3. spec 未写、实际做了：`check-bundle-size.mjs` 的入口解析修正（本次改动暴露的歧义）。
4. spec 未写、刀3 实际做了：**wasm 预算下调**（1,110,000 → 230,000）。原预算的定标依据里 909,563 B gzip 就是被删的 tmLanguage 语法；不随删随降等于把这一档放空 80%，回归将无法被发现。
5. spec 未写、刀3 实际做了：`scripts/perf-bench` 的高亮域从 wasm 出口改量为 Lezer 出口。基准若留在旧出口，等于量一个不再是产品路径的死实现（违反 #233 的基准口径）。

## 未解问题

1. **真机未单独核的两面**：文件只读视图（`FileTabView`，由单测 `pl-*` 断言覆盖）、流式新代码块（同一条 `highlightCode` 路径，未在真机单独触发）。
2. **首次延迟的隔离**：刀2 只测到「切会话 → 首个 span 121.3ms / 结算 421.8ms」（含投影与渲染）；旧引擎的编译阻塞（433/654ms）是**由构造消失**（不再有编译），不是同一指标的 A/B。
3. **`pl-smi` 类归属**（刀2 遗留）：Lezer 侧变量（`pl-v`）与「类名/成员」在部分语言里落到同一 tag；刀2 已按现状映射，未单独立项。
4. **实机证据仍是刀2 那一轮**：刀3~刀6 的验证是「构建产物体积 + 全量门禁 + 基准 + 注入式行为测试」。刀5 的教训是**小代码块的实机验收不足以覆盖高亮路径**——若要做更强的实机验收，样本里必须包含一个 >3k 的块与一个只读大文件。
5. **高亮引擎不做解析状态复用——但产品路径不需要它**（原先这里写成「待做的增量解析议题」，是错的，已更正）：引擎每次调用确实 `startParse(code, [])` 从零解析，但**增长中的同一段文本不会被反复全量高亮**，上游三处已经挡住了这笔浪费：
   - 未闭合围栏由 `StreamingCodeBlock` 渲染（`MarkdownContent.solid.tsx`），逐行输出**纯文本、根本不高亮**——它是过渡态，回合结束才走 markdown 解析路径变成闭合块；
   - 闭合块每实例只高亮一次（`requestHighlight` 命中 `lineHtmls() !== null` 即返回）；
   - 实例重建也被 `codeHighlight.ts` 的 128 条 `(language, code)` 结果缓存吸收。

   另需分清：**markdown 层的尾块增量早已落地**（ADR-0006 / #150 的 graft + 按行拼接，作用于 `markdownRenderModel` 的 `cache:false` 路径）——那是「复用模型子树」，与「复用高亮解析状态」不是一件事，本条原先把两者混为一谈。
   **唯一会随增长反复全量重高亮的地方**是 `CodeBlock.solid.tsx` 的巨块展开（#208：`visibleCode()` 步进增长 ⇒ 每步一个新 key ⇒ 一次全新解析）。那是用户点击驱动、步进式的 append-only 增长（理论上最适合增量复用），单步成本 0.37µs/字符（12k ≈ 4.5ms）落在 8ms 帧预算内，**没有读数显示它是瓶颈** ⇒ 记为潜在收益点，不是欠账。

## 刀 4（说明书与 ADR 同步，已完成）

| 文件 | 改了什么 |
| --- | --- |
| `docs/说明书/Pylon-模块维护地图.md` | 「markdown 与高亮（WASM）」行 → 「markdown 解析（WASM）」：写明高亮已迁出、原因（常驻不可归还的编译峰值，#240 实测 ~30%）、旧资产来源与验证命令（`parity/` 只剩 117 条快照） |
| `docs/说明书/Pylon-项目架构参考.md` | #221 那段的收尾句：把「计算核『整块进、行数组出』边界」更正为「引擎……不再是 wasm 计算核」，并注明边界形状未变故机制与消费方零改动 |
| `.agents/decisions/0018-frontend-compute-core-rust-wasm.md` | 追加**修订 2**：高亮退出 wasm（取代修订 1 表里 WP4 高亮那半）；依据、后果（体积/预算/内存）、退役清单、不变项（comrak 留 wasm、`pl-*` 契约不动）；方法论补一句「当成本形状与算法无关时，换语言不是解法」 |

## 并行交集

- `src/components/chat/{codeHighlight,lezerHighlight}.ts`、其测试、`scripts/check-bundle-size.mjs`。
- 刀3 另碰：`src-tauri/pylon-markdown/**`、`src/infrastructure/compute/markdownCompute.ts`、`package.json`/`bun.lock`、`scripts/{build-wasm.mjs,audit-maintenance.mts}`、`scripts/perf-bench/**`（highlight 域与记账）、`src/{store.ts,domains/workbench/workbenchProjector.ts}` 与 `ChatView.css` 的注释。
- 未触碰：`parseMarkdown`/comrak、`src/renderers/solid-workbench/chat/{CodeBlock,MarkdownContent}.solid.tsx`、`FileTabView.tsx`、`codeBlockDomLifecycle.ts` 机制本体、其余在途域。
