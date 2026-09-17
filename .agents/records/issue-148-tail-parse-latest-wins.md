# Dev Record — #148 流式尾块解析「最新即胜」+ 只读解析成本读数

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-148-tail-parse-latest-wins.md`

## 元信息

- issue：GitHub `AlchemistCxC/Pylon-co-works#148`（`refactor(renderer)`：流式尾块每帧重解析——同步突发下 92% 解析被丢弃、长单块总解析量 O(N²)）
- 来源：本记录是施工记录；同目录 `issue-148-tail-parse-cost.md` 是**先行的调查记录**（测量与结论），两者互补
- 分支：`Ru5t/Reflector`
- 提交范围：`28f2a265..<head>`（见 PR）
- 日期：2026-09-17

## 目标与范围

**要达成**：#148 的目标结构 A（解析请求「最新即胜」）+ B（只读解析成本读数并入既有 `streamingDisplay` 读数）。

**不做**：不做增量解析、不引入 worker、不上流式 markdown parser；不改发布节奏、行集合推导、切分语义、骨架态契约、#141 的等待预算；不改非流式（已提交消息）路径的解析与缓存策略。

**判据取向**：只跳过「其结果必被丢弃」的请求——依据是 Solid `createResource` 的 `loadEnd` 只在 `pr === p` 时提交结果（`node_modules/solid-js/dist/solid.js`），因此跳过与现状**渲染等价**，不是「更快但可能不一样」。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/chat/markdownParseCounters.ts` | 新增叶子模块（无依赖）：`cacheHits` / `parsed` / `skipped` / `parseMs` / `maxParseMs` / `maxTextLength` | 新增 |
| `src/renderers/solid-workbench/chat/markdownRenderModel.ts` | `MarkdownRenderModelOptions`（`cache` + `isCurrent`）；微任务后复查判据、跳过返回哨兵；哨兵按身份撤销、不进 LRU；解析计时记账 | 修改 |
| `src/renderers/solid-workbench/chat/MarkdownContent.solid.tsx` | `MarkdownSegment` 仅在 `useCache() === false`（增长尾块）时传判据 | 修改 |
| `src/renderers/solid-workbench/streamingDiagnostics.ts` | 读数新增 `parseCost: markdownParseCounters()`（既有字段不动） | 修改 |
| `src/renderers/solid-workbench/chat/__tests__/issue148.parseLatestWins.solid.test.tsx` | 新增 6 条回归（模型层 3 + 组件层 3） | 新增 |

## 方案要点

1. **判据**：`isCurrent: () => shouldParse() && text() === source`。解析源是 `shouldParse() ? text() : undefined`，源一变 Solid 就发起新 fetch 并改写 `pr`，旧请求必被丢弃 ⇒ 该表达式与 `pr === p` 同义。
2. **检查点放在动态 import 之前**（**与 issue 正文的「import 之后」有一处偏差**，理由见下）：`buildMarkdownRenderModel` 先 `await Promise.resolve()` 让出一次微任务，再复查判据。放在 import 之前是必要的——调查记录里的测量显示，测试环境一次解析调用链的开销大头是**模块加载路径**（百毫秒量级）而非解析本身（0.2ms 量级），放在 import 之后会让跳过的请求仍然付这笔钱，「突发退化到 O(1)」在测试环境就不成立。语义不变：判据只读调用方当前文本，与模块加载无因果。
3. **缓存安全由模块保证，不靠调用方自觉**：跳过返回哨兵 `SKIPPED_MARKDOWN_ROOT`，其 resolve 后按身份撤销缓存条目（`renderModelCache.get(markdown) === pending` 才删）。因此即便将来有调用方在 `cache: true` 路径上传判据，也不会把空模型毒给同文本的其他行。
4. **判据只出现在尾块路径**：组件侧 `useCache() ? undefined : () => ...`——已提交消息与 stable 前缀不传，它们的解析结果是要长期复用的。
5. **只读读数**：`parsed`/`skipped` 判「最新即胜是否生效」（帧节奏下 `skipped` 应为 0）；`parseMs`/`maxParseMs`/`maxTextLength` 判「长单块值不值得进一步优化」（#148 调查里那笔现场数据缺口）。读数经 `__PYLON_KERNEL_DEV__.diagnostics.read('streamingDisplay')` 的 `parseCost` 取。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| A1 跳过只发生在必被丢弃的请求上 | ✅ 模型层用例：判据为假 → 空模型 + `skipped`，不计 `parsed` |
| A2 突发 O(1) | ✅ 组件层用例：token 级切片一次 tick 喂完 → `parsed === 1`、`skipped > 0` |
| A3 帧节奏零影响 | ✅ 组件层用例：每次发布之间让出事件循环 → `skipped === 0`、`parsed > 1` |
| A4 既有行为测试全绿且**未被修改** | ✅ 全量 `573 passed / 3823 passed`；`git status` 显示无任何既有测试文件改动 |
| A5 门禁 | ✅ `tsc -p tsconfig.solid.json --noEmit` 退出 0；eslint 五个文件干净；`bun run check:frontend` 见证据；CI 双 job 见 PR |
| A6 未新增白名单豁免 | ✅ 未改任何检查脚本与配置 |

## 测试处置

- **新增**：`issue148.parseLatestWins.solid.test.tsx`（6 条：模型层「跳过语义 / 缓存安全 / 不传判据即旧行为」；组件层「突发只解析一次 / 帧节奏零跳过 / 非流式路径不传判据」）。
- **修改/删除既有行为测试：无。**（`MarkdownPendingModel.solid.test.tsx` 的 `cache: false` 契约用 `toMatchObject`，新增的 `isCurrent` 键不影响它；`StreamingMarkdownPerformance.solid.test.tsx` 的解析次数断言不受影响——它 mock 掉了 options 参数，且其用例里 prefix 不随 chunk 变化。）
- 判别性核验：把三个产品文件 stash 回修复前、只留新测试 → **5 failed / 1 passed**（唯一通过的那条锁的是未改动的既有行为），可见回归锁是判别性的，不是恒真断言。

## 证据

**命令与结果**

| 命令 | 结果 |
| --- | --- |
| `bun x vitest run …/issue148.parseLatestWins.solid.test.tsx` | 6 passed（连续 5 轮均 EXIT=0） |
| `bun x vitest run`（4 个相关既有文件） | 23 passed |
| `bun run test`（全量） | `Test Files 573 passed (573)` / `Tests 3823 passed (3823)`，EXIT=0 |
| 修复前对照（stash 产品改动） | 新测试 5 failed / 1 passed |
| `./node_modules/.bin/tsc -p tsconfig.solid.json --noEmit` | 退出 0 |
| `bun x eslint <5 个改动文件>` | 无输出 |
| `bun run check:frontend` | 见下（lint + ipc + 样式/token + coverage + build + bundle + solid-smoke + docs + deps） |
| CI | 见 PR（前端 job 覆盖 `check:frontend`，Rust job 覆盖 `check:rust`） |

**行为等价性说明**（为什么「跳过」不改变渲染）：`createResource.loadEnd(p, v)` 只在 `pr === p` 时提交；判据为假意味着源已变（`text() !== source` 或 `shouldParse()` 转假），Solid 必已发起新 fetch（或把源置空）并改写 `pr` ⇒ 该请求的结果本来就不会进 DOM。因此跳过只省解析器的工作，不省任何可见状态。

## 与 spec 的偏差

1. **检查点前移**（import 之前而非之后）：见方案要点 2，理由是测试环境里模块加载开销远大于解析本身；语义等价性不变。
2. 未登记 ADR：本次未触及路线、公开契约或跨模块结构（判据与缓存安全都在模块内自洽，且由测试锁定），按 `.agents/decisions/` 的既有粒度判断不需要新 ADR。
3. 未改 `docs/说明书/`：该区域未描述尾块解析/缓存策略，无漂移面（已 grep 确认）。

## 未解问题

- 长单块（数千字单段/长列表）在现场的出现频率仍无数据——这正是 `parseCost` 读数要回答的问题；在拿到读数前不评估增量解析。
- 本轮的跳过判据只覆盖「同一 tick 内被取代」的请求。若将来出现「每次发布间隔内解析也完不成」的形态（超长块 + 慢机器），需要在读数上用 `parseMs` 与发布节奏对照后再评估（已记入 #148 的验收判据之外，作为后续观察项）。

## 并行交集

- 本轮文件域：`chat/markdownRenderModel.ts`、`chat/markdownParseCounters.ts`（新增）、`chat/MarkdownContent.solid.tsx`、`streamingDiagnostics.ts`、`chat/__tests__/issue148.parseLatestWins.solid.test.tsx`（新增）、`.agents/` 文档。均已提前声明在 `.agents/L.md`。
- 未触碰 `streamingDisplayScheduler.ts`、`streamingRowCounters.ts`、`streamingMarkdownSplit.ts`、`issue55.rowSetPurity.solid.test.tsx`、`vitest.config.ts`、`docs/说明书/`，也未连带提交其他改动。
