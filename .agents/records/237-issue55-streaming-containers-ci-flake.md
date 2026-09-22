# Dev Record — #237 issue55.streamingContainers 在 CI 偶发红（断言抢在异步高亮之前）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/237（bug；assignee AlchemistCxC）
- 分支：`Ru5t/Reflector`
- 提交范围：`649e477d`（L.md 开工声明）→ `ec745fb4`（第二次修正随该提交落下）
- 日期：2026-09-22

## 目标与范围

**做**：让 `src/renderers/solid-workbench/chat/__tests__/issue55.streamingContainers.solid.test.tsx:90`
不再偶发红。**用户当轮要求「CI 现在是红的你也解决下」。**

**不做**：不动产品代码。高亮异步是 #221 帧预算调度**有意为之**，产品行为正确；红的成因是断言抢跑。

## 归因（先证明与改动无关）

1. **签名一致**：CI run `35679484387`（job 106593106542）与 `35677144907`（job 106586033169）都在
   **同一文件同一行**失败：`AssertionError ... ❯ ...issue55.streamingContainers.solid.test.tsx:90:38`。
2. **与代码改动无关**：`35677144907` 对应的提交 `ad28f0c5` 是 **docs-only**（只动
   `scripts/perf-bench/index.ts` 的理由文案与开发记录），紧邻的另一个 docs-only 提交 `e76a91f5`
   却是绿的 ⇒ 抖动来自环境负载而非代码。
3. **本地稳定通过**：`npx vitest run <该文件>` 连跑 3 次均 6 passed / ~330ms。
4. **机制**：差异只在**高亮 span 有没有落地**（live 侧 `<span class="term-code-text">const value = 1</span>`
   vs replay 侧带 `pl-k`/`pl-c1` 的 span 树）。两条路径的高亮都是异步的（`CodeBlock.solid.tsx`：
   非门控宿主走 `createResource` → `await highlightCode(...)`），而原断言的 `waitFor` 只等到
   **代码块容器**出现——那是首帧就有的。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/chat/__tests__/issue55.streamingContainers.solid.test.tsx` | `matches replay structure for %s` 一个 case：含代码块时把「何时比」推到结算之后 | 修改（测试侧） |

## 方案要点

判据拆两步，**判据本身仍是逐字节严格相等**，只是把「何时比」等到结算之后：

1. 先等 **replay**（终态渲染：文本完整、非流式）的高亮 span 落地 —— 它必然落地，这一步同时钉住
   「高亮确实发生了」（语法包缺失会在此失败，不会静默放过）；
2. 再等 **live**（流式路径，结算更晚）与 replay **收敛**，然后再断言 `bodyHtml(live) === bodyHtml(replay)`。

**第一版修正错在哪（记下来）**：先写成「等两侧都有 span」，结果在 `src/renderers src/sheets`（116 文件
并发）下**超时**——`expected null not to be null`。说明把「两侧都必须出现 span」当条件是过强的：
live 的 `highlightCode` 在负载下结算晚，且语法包缺失时它返回 null ⇒ 组件落成空 `lineHtmls`（无 span）。
改成「锚在确定会结算的 replay 侧 + 等 live 收敛」后，同样 116 文件并发跑绿。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 定向用例连跑绿 | ✅ 3/3 轮 6 passed |
| 并发负载下绿（原偶发场景） | ✅ `npx vitest run src/renderers src/sheets` → 116 文件 / 1080 用例通过 |
| 全量绿 | ✅ `npx vitest run` → 623 文件 / 4678 用例通过 |
| 判据未弱化 | ✅ 仍是 `toBe`（逐字节相等），未改成「不抛就算过」的形态；且新增「replay 必须有 span」这一条正向要求 |
| 产品代码零改动 | ✅ |

## 测试处置

- 新增测试：**无**（修的是既有用例的等待时机）。
- 修改既有行为测试：**1 处**，点名
  `src/renderers/solid-workbench/chat/__tests__/issue55.streamingContainers.solid.test.tsx` 的
  `it.each` 第三组（`nested fence`）。前两组（`nested list` / `blockquote`）**未改**——它们不含代码块，
  没有这层异步差。

## 证据

- CI：run `35679484387` / `35677144907` 的 `log-failed`（同一行同一断言）。
- 本地：`npx vitest run <文件>` ×3；`npx vitest run src/renderers src/sheets`；`npx vitest run`（全量）。
- 提交：`156cb801`（第一版）+ `ec745fb4`（改为锚 replay + 收敛的双步判据）。

## 未解问题

1. **同类抢跑是否还有别处**：本仓已有多例（#141 / #175 / #157 / 本条），都是「jsdom 调度型用例在并发
   饱和下抢跑」。本轮只修了 CI 实际红的那一处，没有做全仓普查。
2. **`waitFor` 默认超时的适配**：本轮用 `{ timeout: 5_000 }` 覆盖默认 1s。若将来 CI 更忙，这个数还会
   不够；根治方向是让「已结算」有个显式信号（例如测试里注入假高亮），而不是靠时间。

## 并行交集

- 只碰一个测试文件；`src/renderers/**` 的产品代码零改动。
