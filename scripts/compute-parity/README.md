# compute-parity · 计算纯函数 TS↔wasm 对照脚手架

issue #220（计算核 wasm 化）的配套基建：对 wasm 计算核的**每一个计算出口**，
用迁移前/保留的 TS 原生实现做同输入对照——parity（两侧归一后逐字节一致）与
性能（同 harness 中位数比值）共用同一份套件定义。

## 跑法

```bash
# parity 门禁（vitest，默认 m 档；COMPUTE_PARITY_SCALE=full 加 l 档）
vitest run scripts/compute-parity.test.mts

# 性能对照（默认 m 档、3 轮中位数；**必须 vite-node**——套件 import 的 src 模块链
# 里有无扩展名相对 import，裸 node 解析不了）
npx vite-node scripts/compute-parity-bench.mts
COMPUTE_PARITY_SCALE=full COMPUTE_PARITY_ROUNDS=5 npx vite-node scripts/compute-parity-bench.mts
```

> 逃生门：crate 上有他人**在途改动**导致 wasm 重建失败时，可
> `npx vitest run --config scripts/compute-parity/vitest.config.ts`
> 针对既有产物跑（本地 config 绕过共享 globalSetup 的重建检查）。这是显式
> opt-in，产物新鲜度责任在调用方；默认门禁路径不弱化。

## 结构

| 路径 | 职责 |
|---|---|
| `harness.ts` | CaseSpec/PairSpec/Suite 类型、stableJson 比对口径、parity/性能双跑器、维度过滤（scale × shape × edge × flow） |
| `index.ts` | wasm 装载上下文、全套件注册表、**覆盖门**（REQUIRED_EXPORTS 必须全部有对照 pair） |
| `baselines/` | TS 侧基线实现（冻结/雕刻，见下）——**不在任何生产路径，不 import 进 src** |
| `fixtures/` | PYPB v1 帧编码器、events 语料、workbench envelope 生成器、切分/markdown/高亮语料 |
| `suites/` | 七个域套件：canonical / events / projector / streaming-split / streaming-budget / markdown-parse / markdown-highlight |

## TS 基线的两种来源（baselines/ 头注逐一声明出处）

1. **冻结整文件**（逐字节等于迁移前，只改 import 路径）：
   - `oldWorkbenchProjector.ts` ← `f784dc98:src/domains/workbench/__baselineOldProjector.ts`（原样取自 `76cbc819^`）
   - `oldStreamingMarkdownSplit.ts` ← `76cbc819^:src/renderers/solid-workbench/chat/streamingMarkdownSplit.ts`
2. **雕刻**（纯数学函数逐字拷贝 + 组装方式对齐 Rust 权威移植）：
   - `oldRevealEngine.ts` ← 旧 `streamingDisplayScheduler.ts` 的预算数学（advancePrefix/revealBudget/D1 摊分）+ `pylon-compute/src/streaming/budget.rs` 的状态机形状
   - `oldMarkdownParsePipeline.ts` ← 旧 `markdownRenderModel.ts` 的 unified/remark 解析核
   - `oldHighlightEngine.ts` ← 旧 `codeHighlight.ts` 的 starry-night 装配 + markdownComputeParity 的 token 扁平口径
   - `oldCoverageMerge.ts` ← 旧投影核的 coverage 区间合并

事件域与 canonical 域、part 级投影原语的 TS 实现仍在生产树上
（`src/domains/events/**`、`contentPartSchema.ts`），套件直接 import 活实现。

## 场景维度

- **scale**：xs / s / m / l（l 只在 `COMPUTE_PARITY_SCALE=full` 下参与）
- **shape**：结构变体（mixed-flow、multi-row、astral、wire、matrix……）
- **edge**：空串、畸形输入、非法选项、未闭合围栏、NaN 时刻……
- **flow**：cold / paged / idempotent / prefix-scan / replay-script（stateful 函数的对照单位是驱动脚本）

## 已过审差异（known-diff，不算红）

| pair · case | 差异 | 出处 |
|---|---|---|
| parseMarkdown · footnote-probe | remark-gfm 脚注形状 vs comrak 脚注形状 | #220 WP4 parity 清单 |
| highlightBlock · js-sample / go-sample | syntect 与 starry-night 的引擎级残差 | `src-tauri/pylon-markdown/parity/parity-report.json` |
| splitStreamingMarkdown(prefix-scan) · growing-source | 前缀恰以孤立 UTF-16 高代理结尾时，Rust 字符串无法持有，serde 编组落成 U+FFFD；TS 原样保留。UTF-8/UTF-16 编组层固有损耗，非切分逻辑分歧 | 本脚手架差分发现，随套件注释过审 |

新增已过审差异必须走 parity 门禁流程（更新 parity-report 清单或在此表登记理由），
不许静默加进 `knownDivergences`。

**边界归一口径**：`harness.ts` 的 `normalizeBoundaryMaps` 把 serde_wasm_bindgen 编成
JS `Map` 的 BTreeMap 深转回普通对象（与 `pylon-markdown/src/wasm_exit.rs` 头注记载的
边界修复同语义）；当前产物已在边界给普通对象，该归一是空操作，保留作防御。

## 扩展约定

1. wasm 计算核新增出口 → 在 `index.ts` 的 `REQUIRED_EXPORTS` 登记 → 覆盖门变红 →
   补对应 suite pair（TS 侧找迁移前实现或树上活实现，出处写进头注）。
2. 编组变体出口（`*Json`）与诊断出口（`markdownEngineVersion`）在 `EXEMPT_EXPORTS`。
3. 改帧格式：`fixtures/eventsFrame.ts`（PYPB v1）与生产 parity 测试要一起改。

## 与既有 parity 门禁的关系

`src/**/__tests__/*Parity*.test.ts` 五个门禁是**产品路径**的行为锁（快照/corpus
驱动）；本脚手架是**计算核面**的差分基建：覆盖全部出口、可配维度、性能对照、
冻结 TS 基线集中管理。两边互不替代。
