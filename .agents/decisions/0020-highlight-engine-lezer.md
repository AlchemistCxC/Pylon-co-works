# ADR-0020 语法高亮引擎选型：Lezer（退役 wasm/syntect 语法资产）

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0020-highlight-engine-lezer.md`

- **日期**：2026-09-22
- **状态**：已采用（引擎由用户拍板：「我要用 lazer」；依据为本轮实测对比）
- **议题**：issue #241；上游 #240（渲染器内存分布调查：语法资产占可控内存 ~30% 且不可归还）；修订 ADR-0018 修订 1 中「WP4 markdown 与高亮保留在 wasm」的**高亮那一半**

## 背景与约束

#240 实测出高亮的两笔账：① **内存**——渲染器进程里语法资产约占可控内存 30%，单个语言编译峰值最高 42MB（css）且**不可归还**（wasm 线性内存只涨不跌、GC 无效）；② **延迟**——首次用到某语言时同步编译阻塞主线程 0.5–1s（release native css 433ms / ts 654ms，wasm 更慢）。

约束：插件四样契约（含 `renderer.codeHighlight` 的 provider 契约）不可破；`parseMarkdown`（comrak）留在 wasm；`pl-*` 类名与颜色定义（CSS）尽量不动；浏览器预览模式必须继续可用。

## 备选方案

| 方案 | 否决理由（均为**同机实测**，非推断） |
| --- | --- |
| **继续 wasm，只裁关键字表 + 槽位驱逐** | 能拿回 css 编译峰值 −88%（裁 10 条关键字表）且零可见代价，但：ts 无单点（去 13 条大 pattern 峰值仅 −2%）；首次 0.5–1s 阻塞仍在；**「不可归还」这个结构性属性不变**——GC 后地板纹丝不动。属务实兜底，不解决根因。 |
| **换回 starry-night（"TS 原生"）** | ① **它本身就是 wasm**（`vscode-oniguruma`），并非「不用 wasm」；② 内存更差：import 就 +25.2MB heap+ext，css +32.9MB / ts +66.1MB，三语言 heap+ext **+99.7MB**（我们四语言编译峰值合计才 36.5MB）；③ **同样不可归还**——丢弃引擎 + 3×强制 GC 只回落 0.6/90MB（oniguruma 的线性内存）。唯一优势是首次延迟（42ms）与类名天然一致。 |
| **换 Prism（纯 JS 正则）** | 真无 wasm、内存最小（≈3.7MB）、覆盖率也够（68.5%），但：**无增量解析**（流式尾块每帧全扫）；token 体系与 `pl-*` 完全不同且更细（连 punctuation/operator 都标）⇒ 映射与观感重做；**应用里仍是两套高亮引擎**（编辑器已用 Lezer）。 |
| **把 wasm 挪出渲染器进程** | 不成立：Chromium 的 dedicated worker 与页面**同进程**，账仍记在渲染器上；service worker 那类能挪出进程但拿不到同步返回（#221 的帧预算调度会变形）。 |

## 决定

**高亮引擎改用 Lezer（`@codemirror/language-data` + `@codemirror/language` + `@lezer/highlight`，均为树内既有依赖）。**

1. 只替换 `src/components/chat/codeHighlight.ts` 的 builtin 实现；**四处消费点（插件 provider / 聊天代码块 / markdown 内嵌代码块 / 文件只读视图）共用的契约 `highlight(language, code): Promise<string | null>` 不变** ⇒ 消费方零改动。
2. `pl-*` 类名与 CSS 颜色定义**不动**：被替换的是 Rust 侧 `starry-theme.json` 那张「TextMate scope → 类名」表，改为一张「Lezer tag → 类名」表。
3. 退役 wasm 侧高亮：`highlight.rs` 的语法机器、`wasm_exit.rs` 高亮出口、`assets/grammars/*`（728KB/14 个）、syntect 依赖、parity 快照的高亮半、`starryCore.ts`；退休 `@wooorm/starry-night` + `vscode-oniguruma`。
4. **`parseMarkdown`（comrak）留在 wasm**——crate 与模块不消失，只变小；wasm 预算重定标。
5. #221 的视口降级 + 帧预算调度器**先保留不动**（视口降级还承担内存职责），实测后再议是否简化。

## 后果

- **正面**：语法资产那 30% 与「不可归还」一起消失；单次 4KB 高亮 99.6ms → 1.13ms（≈90×）；首次 0.5–1s 阻塞消失；**应用从两套高亮引擎收敛成一套**（与编辑器同一引擎）；净减 2 个 runtime 依赖；顺带修好 cpp（现状几乎完全不着色，见下）。
- **负面 / 代价**：
  1. **观感变化**：有色字符覆盖率 47.7% → **69.4%**（不是掉色，是**变多**）；换色 8.9%（同 token 类名不同）；掉色仅 3.3% 且多为映射表可补。要逐语言定「哪些 tag 上色」。
  2. 主题映射要重建并逐语言校对（CSS 不动，但 tag→`pl-*` 表是新的资产）。
  3. parity 门禁的高亮半要换基线或退役；`starry-night` 那条 TS 基线随之退休。
- **风险**：
  1. **cpp 有意分叉**：现状 70 字符 0 有色 → Lezer 55（ADR-0018 记过的「单语法集 ⇒ include 解析为空」），要作为已过审差异登记。
  2. **CodeMirror 进主 chunk**：必须动态 import，否则 `check:bundle` 的 MAIN_BUDGET 会红。
  3. 文件只读视图共用同一入口，其 `pl-*` 断言要一起复核。

## 证据

- 对比 spike（本轮，临时脚本已删）：内存 / 延迟 / 流式尾块 / 覆盖率 / 掉色 四张表见 issue #241。
- 内存机制与峰值来源：#240 的原生计数分配器 bisect（css 编译 churn 543MB、峰值 18.06MB；ts 峰值 12.67MB；裁剪那 10 条关键字表 → 峰值 −88%）。
- 真机台阶：#240 的 per-PID 探针（css 块入视口 → 渲染器 private +42.0MB、go +1.4MB）。
- 消费面与契约：`src/contracts/rendererContentPoints.ts:18`、`src/components/chat/codeHighlight.ts`、`src/plugins/core/renderer/builtinRenderContent.ts:260`、`src/renderers/solid-workbench/chat/{CodeBlock,MarkdownContent}.solid.tsx`、`src/sheets/file/FileTabView.tsx:103`。
