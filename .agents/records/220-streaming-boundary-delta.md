# Dev Record — 220 streaming 边界收口（揭示 tail 化 · ends 出口 · 增量 UTF-16 计数）

> 入库保留。规格（一次性）见 `.agents/spec/220-streaming-boundary-delta.md`。
> 本条目是 [`220-frontend-compute-core-wasm-completion.md`](220-frontend-compute-core-wasm-completion.md)
> 的续篇（该文件 §31 结算 scope 收窄后，streaming 是 wasm 保留面，本轮收它的边界账）。

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/220（refactor；续做，分支 `Ru5t/Reflector`）
- 日期：2026-09-21
- ADR：[`0018`](../decisions/0018-frontend-compute-core-rust-wasm.md) 修订 1（scope 收窄）的延伸——本轮不改路线，只收保留面的边界形状
- 授权：用户当轮放行（「立刻全部开工」），含两处跨语言契约变更

## 目标与范围

**做**：把 streaming 两个 wasm 出口的每拍/每发布成本从 O(全文) 降到 O(新增/尾)：

| 项 | 内容 | 契约 |
| --- | --- | --- |
| S1 | `RowReveal` 由整条已揭示前缀（`value`）改为增量尾巴 `{ tail, revealedLength }`；调度器逐列表裁决改 `resolveTailValue` | **变更**（wasm↔JS wire） |
| S2 | 新增 `splitStreamingMarkdownBlockEnds`（UTF-16 块结束偏移数组）；`MarkdownContent.deriveRowSpecs` 切换，块内容 JS 侧自切片；扫描抽 `stable_block_byte_ends` 三出口共用 | 新增（旧三出口保留） |
| S3 | `RevealRow` 增量 UTF-16 计数（`canonical_units`/`revealed_units`），`pending_units` 从 O(全文)/拍 → O(行数)/拍 | 内部（wire 不变） |
| S4 | 围栏尾块 CRLF `contains` 守卫；`StreamingMarkdownBlocks` 按位缓存 stable 行修剪文本 | 内部 |

**不做**：markdown 域（12–25× 已赢，无账可收）；投影/events（已按 §31 回退 TS）；
`splitStreamingMarkdown` / `splitStreamingMarkdownBlocks` / `findLastStableBlockBoundary`
旧出口（parity 与契约测试钉着，且 scaffold 套件以它们为对照物）。

## 方案要点

1. **S1 的逐列表语义**（本轮最容易错的地方）：决策语义从「揭示前缀全文」变成
   「揭示位现在有 `revealedLength` 个 UTF-16 单元」。常态（列表恰在拍前揭示位）直接
   追加 tail；双列表短暂分叉时不追加（会留缺口），按旧 `resolveListValue` 的 clip 语义
   自愈——目标延伸显示文本则推进到 min(本列表目标, 揭示位)；显示态超前于引擎或内容
   不连续则该列表本拍保守不动。旧实现的「每拍全量改写」自愈路径由
   `revealedLength` + `startsWith` 检查逐分支对齐。
2. **S3 与「TS 同运算顺序」契约不冲突**：预算/欠账量纲是整数值 f64（< 2^53），
   每步加法精确 ⇒ 增量累计与从头 `encode_utf16().count()` 逐位一致。求和仍是
   「逐行相减再求和」的原顺序。
3. **S2 的共享扫描**：切分语义只存在于 `stable_block_byte_ends` 一处；blocks 出口
   （兼容）、ends 出口（热路径）、`findLastStableBlockBoundary`（免 String 分配，
   bench m 档 0.40→0.13ms）三个出口都从它推导。
4. **scaffold 的对照归一即验证**：预算套件 wasm 侧按「拍前已揭示 + tail」重建前缀
   并断言 `revealedLength` 一致，再与 TS 基线的整条前缀逐拍对照——归一化过程本身就是
   生产消费方（`resolveTailValue`）追加语义的复验。

## 基准（改前/改后同脚本，Node 宿主、一进程一配置、5 轮中位数；临时脚本已删，形状在括号内）

| case（形状） | 改前 | 改后 | 变化 |
| --- | --- | --- | --- |
| reveal-long（3000 拍 × 60 单元增量，累计 18 万单元） | 822.1ms | **10.7ms** | **77×** |
| reveal-burst（20 万单元一次突刺后 tick 排干） | 424.5ms | **7.5ms** | **57×** |
| split-growing（400 块逐块增长、每步全量切分，旧 blocks 出口） | 22.6ms | 22.3ms | 持平（旧出口） |
| split-ends-growing（同形状，生产新的 ends 出口） | — | **4.7ms** | 4.8× vs blocks 出口 |
| split-full（5000 块单调用，旧出口） | 1.5ms | 1.6ms | 持平 |
| fence-tail（9.6 万字符围栏体，无 CRLF） | 0.36ms | 0.29ms | −20%（免整份复制） |

scaffold 对照（`compute-parity-bench.mts`，wasm/ts，<1 表示 wasm 快）：

- `long-stream`（**l 档新增**，2000 拍 × 40 单元）：TS 基线 300ms vs wasm **66.9ms = 0.22×**
- `smooth-m` 0.89× → 0.40–0.58×；`burst-drain` 0.67× → 0.35–0.39×
- `astral-grapheme` **2.09×（旧最差行）→ 0.77–1.22×**（S3 消掉每拍整串重编码）
- `findLastStableBlockBoundary blocks-m` 0.38× → **0.32×**（免 String 分配）
- `splitStreamingMarkdownBlockEnds blocks-l` 0.28×（TS 侧按旧 blocks 基线推导 ends）
- streaming-budget 域小结：7 快/2 慢 → **8 快/1 慢**（m 档）

机制（照实分开写）：S1/S3 的收益是**每拍过界字节数**（整前缀 → 尾巴）与**每拍分配**
（`format!` 整份复制 + serde 整串编组 → 尾巴切片）， O(N²)/流 → O(N)；
S2 的收益同形（整组块字符串编组 → u32 数组）。

## 内存

- 流式域核线性内存不是账：memory runner 全表高水位 **1.25MiB**（装载后 1.06MiB），
  各 case 核增长 0.0K、保留/次 ≈ 0（噪声级）——与 §25.4「稳态两核 3.5MiB」同口径。
- 实际收益在 **JS 侧瞬态垃圾**：改前每拍把整条已揭示前缀字符串送过界（60fps 下
  O(N)/拍的新生代分配，长流末端单拍即 ~360KB 字符串），改后每拍只剩 O(尾)。
  这笔没有独立仪器化读数，机制与上表耗时变化互为印证，照实标注为分析而非实测。

## 契约变更与测试处置

1. **`RowReveal` wire 变更（S1）**：TS 消费方仅 `streamingDisplayScheduler.ts` 一处
   （`decisions` 值改持整行、`planNextLength` 判据用 `revealedLength`）。
   `streamingCompute.ts` 类型同步；`mirrorText`/`revealedText`/`revealedUnits`
   观测面不变（parity 漂移断言继续可用）。
2. Rust 新增 5 测：tail 拼接==整条前缀（长度守恒逐拍断言）、astral tail 的
   UTF-16 揭示位、`advance_graphemes`==`advance_prefix` 参考（300 随机 case）、
   ends 与 blocks 同源（定向 + 120 随机前缀）。`cargo test -p pylon-compute --lib`
   → **36 passed**（31→36）。
3. TS 既有测试**零修改**全绿：四个调度器行为套件（tail 追加经真实调度器差分）、
   `streamingMarkdownSplit.test.ts`（旧出口契约）。`streamingComputeParity.test.ts`
   仅**追加** ends 不变量（⑥），原 ①–⑤ 逐条未动。
4. scaffold：预算套件 `replayWasm` 增 tail 归一（断言揭示位一致）；split 套件新增
   `splitStreamingMarkdownBlockEnds` pair（corpus + prefix-scan + blocks-s/m/l）；
   预算域新增 `long-stream`（l）。parity 门禁 **126 项：ok 125 / known-diff 1 /
   mismatch 0**（full 档 129 项；known-diff 仍是孤立代理表征差异）。

## 证据

- `bun run test` → **619 文件 / 4604 用例通过**，0 失败
- `bunx tsc -b` exit 0；`bun run lint` 0 error（仅剩既存 RightRailHost 1 warning）
- `cargo test -p pylon-compute --lib` → 36 passed；`cargo clippy -p pylon-compute --lib --tests` 0 warning；`cargo fmt -p pylon-compute -- --check` 通过
- `bun run check:bundle` PASS（pylon-compute 120,581 B raw / 预算内；回退后预算 1,110,000）
- parity scaffold 速度/内存表见上；memory runner：流式域核高水位 1.25MiB

## 未解问题

1. **`github/main` 合并推迟**：开工时工作树有回退施工（§31）的在途改动且与 #223 来向的
   main 重叠（App.tsx 等），按 AGENTS §2.1 不动他人现场；其已本地提交（`fa4aab5d`），
   合并在其进入 main 后补做。
2. **实机（webview2-mcp）复验**：§31 已挂账（回退后内存读数失效），本轮边界收口叠加其上，
   应在实机复验时一并取数（涉及重编 release + 换 `F:\A-I\Platform\Pylon` 的 exe，独立一轮）。
3. reveal-long 改后 10.7ms 的剩余构成是字素步进（预算封顶 128 单元/拍 → 3000 拍 × O(预算)）
   与 O(尾) 分配，已接近该协议形状的下界；再往下是「降拍数/合批」的编排题，属 #212 的
   节奏契约，不动。

## 并行交集

- 与 §31 回退施工同树并行：其改动（workbenchProjector / agentWorkbenchSession /
  bootstrap / scaffold harness+index 等）全程未触碰；其收工提交 `fa4aab5d` 后工作树
  只剩本轮 8 个文件。全程 pathspec 提交。
- 开工声明：`.agents/L.md` [2026-09-21 22]。
