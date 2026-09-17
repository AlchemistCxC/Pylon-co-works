# Dev Record — #150 尾块解析增量 graft（路线 A）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-150-tail-incremental-parse.md`

## 元信息

- issue：GitHub `AlchemistCxC/Pylon-co-works#150`（`perf(renderer)`：尾块解析从「每帧整块重解析」降到增量/离线程）
- 路线决策：`.agents/decisions/0006-streaming-tail-incremental-parse.md`（**路线 A：主线程 graft**；否决 worker 与长尾限频）
- 分支：`Ru5t/Reflector`（基线 `f9e9db71`，含 #148/#149）
- 日期：2026-09-17

## 目标与范围

**要达成**：增长尾块的解析从「每收到一个新文本就整段重解析」降为「纯文本追加走 graft、结构字符才整段重解析」，且渲染结果与整段重解析**逐块一致**。

**不做**：不引入 worker、不引入第三方增量 parser、不做后缀解析（把新树的块结构嫁接到旧树）；不改发布节奏、行集合推导、切分语义、骨架态契约、`cache: false` 语义、#148 的最新即胜判据；不改组件层（调用点零改动）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/chat/markdownRenderModel.ts` | `incremental` 选项；graft 判据（`PLAIN_DELTA` / `EXTENDABLE_PUNCTUATION` / 脊线 + 祖先链 + endsWith）；基座 MRU；整段重解析结果入基座 | 修改 |
| `src/renderers/solid-workbench/chat/markdownParseCounters.ts` | 新增只读计数 `grafted` | 修改 |
| `src/renderers/solid-workbench/chat/__tests__/issue150.incrementalGraft.test.ts` | 逐前缀差分（24 夹具 + 长列表抽样）+ 方向性用例 + 成本用例 | 新增 |

`MarkdownContent.solid.tsx`、`streamingDiagnostics.ts`、`vitest.config.ts`、`docs/说明书/` 均未改动。

## 方案要点

**判据**（全部成立才 graft，否则回退整段重解析；逐条见 ADR-0006 与模块内 docstring）：

1. 新文本是基座的严格后继，差量非空；
2. 差量只含白名单字符（ASCII 字母/数字、半角空格、全部非 ASCII）：CommonMark 的构造只由 ASCII 标点触发、行尾只认 U+000A/U+000D；
3. 基座文本不以换行结尾（行首是块级构造的触发位）；
4. 落点 = 最右**内容**文本节点（每层从后往前跳过纯空白文本节点——列表项之间与列表结尾的 `"\n"` 是结构分隔符），且祖先链只含 `p/li/td/th/h1-h6/blockquote/…`；
5. 差量末尾空白按 CommonMark 的块末剥离规则去掉后再拼接（纯空白差量直接复用基座模型）；
6. 基座文本以该文本节点的值结尾（落点确实在它内部，且渲染值与原文一致）；
7. 该文本节点末尾 32 字内无 ASCII 标点（挡住「纯文本字符延长已有构造」：GFM 自动链接、实体、转义、未闭合标记的收尾）。

**基座**：模块级 MRU（文本 → 已解析模型，容量 32），只由尾块路径（`cache: false`）写入；取基座时由新到旧最多探测 4 个候选。`incremental: false` 强制整段重解析（差分测试的参照路径，也是回滚开关）。

**计数器语义**：graft 命中记 `grafted` 且**不进** `parseMs`；整段重解析记 `parsed` 并累计 `parseMs`/`maxParseMs`/`maxTextLength`。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| A1 逐前缀差分一致 | ✅ 24 个夹具的**每个前缀** + 真机形状长列表按 3 字抽样，增量结果与整段重解析 `toEqual` 完全一致 |
| A2 graft 确实发生 | ✅ 纯中文夹具：`parsed === 1`、`grafted === 长度-1`（除首步无基座） |
| A3 该回退的必须回退 | ✅ 结构标点/换行/行首构造/行内元素落点/URL/实体/转义 逐条断言未 graft |
| A4 真机形状成本下降 ≥10× | ✅ 2931 字 40 项列表、1466 步：`parsed` 1466 → **132**（11.1×），解析 CPU 2368 ms → **197 ms**（12.0×） |
| A5 既有契约不变、既有测试未改 | ✅ 全量 `574 passed / 3854 passed`（基线 573/3823 + 新增 1 文件 31 条）；`git diff` 未触及任何既有测试文件 |
| A6 门禁 | ✅ `tsc -p tsconfig.solid.json --noEmit` 退出 0；eslint 干净；`check:solid` / `check:frontend` / CI 见证据 |

## 测试处置

- **新增**：`issue150.incrementalGraft.test.ts`（31 条：24 组逐前缀差分 + 长列表抽样 + 方向性 5 组 + 成本 1 条）。
- **修改/删除既有行为测试：无。**

**变异核验**（逐个关掉判据，确认差分测试有判别力）：

| 变异 | 结果 |
| --- | --- |
| M1 关掉叶子尾部标点守卫 | ❌ 4 条转红 |
| M2 关掉祖先链守卫 | ❌ 2 条转红 |
| M3 关掉纯文本差量守卫 | ❌ 12 条转红 |
| M4 不做块末空白剥离 | ❌ 15 条转红 |

## 证据

**真机形状的前后对比**（同一夹具、同一 2 字步长揭示序列；`parseMs` 为解析器内累计耗时，来自计数器）：

| 夹具 | 每步整段重解析 | 增量 graft | 倍数 |
| --- | --- | --- | --- |
| 40 项列表（2931 字 / 1466 步） | parsed 1466、parseMs 2368、wall 2559 ms | parsed **132**、grafted 1334、parseMs **197**、wall 215 ms | 次数 11.1×、CPU 12.0× |
| #55 形状文本（3078 字 / 1539 步） | parsed 1539、parseMs 2483、wall 2536 ms | parsed **168**、grafted 1371、parseMs **178**、wall 195 ms | 次数 9.2×、CPU 13.9× |

**差分测试逮到的两条真实缺陷**（实现过程中，均已修）：

1. **块末空白被剥**：CommonMark 把块内容末尾空白剥掉（`The ` 解析出 `The`），拼接保留它 → 与整段重解析差一个空格。修法：拼接前按同一规则剥离差量末尾空白（并依赖「落点容器的祖先链」保证该规则适用）。
2. **落点落在结构分隔符上**：remark-rehype 在列表项之间/列表结尾补 `"\n"` 文本节点，原脊线取「最后一个子节点」正好落在它上面 → `endsWith` 判据失败、拼接路径全灭（列表场景 graft 命中率 0）。修法：每层从后往前跳过纯空白文本节点。

**门禁**（最终代码）：`bun run test` → `574 passed / 3854 passed`，EXIT=0；`bun run check:solid`、`bun run check:frontend`、`tsc -p tsconfig.solid.json --noEmit`、eslint 见 PR 与 CI 结果。

## 与 spec 的偏差

1. **未做后缀解析**（spec 与 ADR 已记录）：只做「可判定为纯文本追加」的拼接，不做「解析后缀再嫁接到旧树」。理由是 markdown 的非局部性会让嫁接本身成为风险源；该子集覆盖约 9 成的流式发布，已把整段重解析降到与块内结构边界数成正比。
2. **多了一条判据**（判据 5，块末空白剥离）：spec 列举判据时未包含，实现中由差分测试发现并补上。
3. **计数器多了一个字段**（`grafted`）：spec 只要求「可看出比例」，实现为显式字段。

## 未解问题

- 残余成本仍与「块内结构边界数」成正比（列表场景 2931 字仍有 132 次整段重解析——主要是行首标记与换行处）。要再降需要真·流式解析器（按 ADR-0006 备选方案另行立项），当前量级（12× 下降、长块 CPU 从 2.4 s 降到 0.2 s）已达成 issue 的目标。
- 现场读数：`parseCost.grafted` 与 `parsed` 的比例可在真机验证本改动的实际生效程度（本轮未做真机复测——应用需从本分支重建；测试环境与真机同为 V8，量级可比）。

## 并行交集

- 文件域已在 `.agents/L.md` 声明；本轮只碰 `markdownRenderModel.ts`、`markdownParseCounters.ts` 与新增测试文件 + 两份 `.agents/` 文档。
- 未触碰 `MarkdownContent.solid.tsx`、`streamingDiagnostics.ts`、`streamingMarkdownSplit.ts`、`streamingRowCounters.ts`、`streamingDisplayScheduler.ts`、`vitest.config.ts`、`src/renderers/solid-workbench/input/**`、`tools/webview2-mcp/**`、`src-tauri/**`；未连带提交工作区其他改动。
