# Dev Record — #370 markdown 列表项双符号（原生 marker 与 ::before 叠加）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 规格原稿：`.agents/spec/370-list-marker-dedup.md`（不计入版本库）。

## 元信息

- issue：[#370](https://github.com/AlchemistCxC/Pylon-co-works/issues/370)
- 分支：`kumo/prometheus`
- 提交范围：`abc4bf64..fdc875e0`（代码与用例；本记录另计）
- 日期：2026-09-26
- 署名：[Penrose]
- 来源：用户实机反馈——「markdown解析，前面那个小小的点会重复出现很影响观感，你顺手修复下」。取证工具 `tools/webview2-mcp`（CDP 9222，实机 `getComputedStyle`）。

## 目标与范围

**目标**：markdown 列表每个条目只画一个符号（无序列表的符号由 `::before` 分级画，有序列表用原生序号）。

**不做什么**：不动渲染器的类名契约（`MarkdownContent.solid.tsx`）、不动分级符号本身与列表缩进几何、不动其它 `list-style` 用法、不动 tsx/主题 token/Rust。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css` | 紧邻基础 `::before` 规则处新增两条：`ul:has(> .term-li){list-style:none}` 与 `ol:has(> .term-li) > .term-li::before{content:none}`（含原因注释） | 修改 |
| `src/renderers/solid-workbench/chat/__tests__/ChatView.css.test.ts` | 新增 CSS 文本契约用例（两条规则 + 三级分级符号仍在） | 修改 |

## 方案要点

- **根因**：符号来源有两套且从未互斥——`li.term-li` 是 `display:list-item` + `list-style-type:disc`（UA 画原生 marker），而 CSS 又用 `::before` 画分级符号（基础 `- `、assistant 内 `•  `/`◦  `/`▪  `）。两套同时生效 ⇒ 每个条目两个点。
- **作用面限定**：用 `:has(> .term-li)` 只在渲染器产出的 markdown 列表上生效（本仓既有 `:has()` 先例：`ChatView.css:2037/2107/2110`、`ControlCenter.css:63`），不波及其它 `ul/ol`。
- **OL 的取舍**：原生 marker 给 OL 提供序号（语义），故保留；去掉叠加的 `::before` 破折号。
- **不动缩进**：`ul{padding-inline-start:22.5px}` 保持原样，实测文本起点 x 不变（330 → 330）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 实机：markdown `ul/li` 的 `list-style-type` 变 `none`，`::before` 仍为 `"•  "` | 达成（下表） |
| 实机：文本几何不变（不因去 marker 而挪位） | 达成（`liTextX` 330→330、`ulX` 291、`ulPaddingInlineStart` 22.5px 均不变） |
| CSS 契约用例红/绿双向可判 | 达成（真删规则 ⇒ 用例红 `expected '...' to match /ul:has\(> \.term-li\).../`，恢复 ⇒ 31 passed） |
| `check:first-party-styles` / `check:solid` / `build` / `lint` | 达成（见证据） |

### 实机对照（同一会话 `smuhyyhy7`、同一 3 项无序列表）

| 量 | 修复前 | 修复后 |
| --- | --- | --- |
| `ul.list-style-type` / `li.listStyleType` | `disc` | `none` |
| `li::before.content` | `"•  "`（`rgb(122,162,247)`） | `"•  "`（同色，未变） |
| `li.display` | `list-item` | `list-item`（保留语义，marker 已关） |
| `li` 文本起点 x / `ul` x / `ul.padding-inline-start` | 330 / 291 / 22.5px | 330 / 291 / 22.5px |

取证方式：`bun run build` → `cargo build`（debug）→ 以 F: 便携版 `data/` 的**副本**跑隔离实例（CDP 9222）→ `getComputedStyle`。构建产物新鲜度已核：exe 内嵌本轮资产名 `first-party-pylon-renderers-DBnRrNO1.js`，且该资产含 `ul:has(>.term-li){list-style:none}`（压缩后文本）。

## 测试处置

- 新增：`ChatView.css.test.ts` → `#370：markdown 列表的原生 marker 与 ::before 二选一`。
- 修改/删除既有行为测试：**无**（`ChatView.css.test.ts` 其余 30 条原样通过）。

## 证据

- 测试：`bun run test src/renderers/solid-workbench/chat/__tests__/ChatView.css.test.ts` → `Tests 31 passed (31)`
- 门禁：`bun run check:first-party-styles` exit 0；`bun run check:solid` exit 0；`bun run build` 绿；`bun run lint` 0 errors（1 条既有告警）
- 实机：见上表

## 与 spec 的偏差

- 无。spec 未决问题（OL 未做实机观测）保留：本次现场会话里没有 `ol`，OL 的一半由机制分析 + CSS 契约用例覆盖。

## 未解问题

- OL 实机观测待补（找一条带编号列表的回复即可复验）；本次不改其序号来源，仅去掉叠加符号。
- 本仓 CSS 契约测试是**文本正则**断言：注释里出现同样文本也会满足断言（本次反向验证时踩到一次）。要让断言更硬需要解析 CSS 或断言编译产物，属测试基建议题，不在本 issue。

## 并行交集

- 只碰 `ChatView.css` 与 `ChatView.css.test.ts`；`ChatView.css` 是共享热点文件（多 agent 可能同时改），施工声明已在 `.agents/L.md` 记录（`e15fc57b`）。
