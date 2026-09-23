# ADR-0021 · markdown 数学公式与脚注的解析/渲染路线

日期：2026-09-23 · 状态：已验证（随 #267） · 关联：ADR-0018（计算核下沉）、ADR-0020（高亮 Lezer）、issue #267

## 问题

markdown 管线（comrak → RenderNode → Solid）缺两块 GFM/常见 agent 输出能力：数学公式（`$…$`/`$$…$$` 全裸奔）与脚注（`[^n]` 引用与定义被解析侧整体丢弃=内容丢失）。agent 回复里的推导/算法/统计是公式高频场景。

## 备选

**A. 解析层开 comrak 内建扩展**（math_dollars + footnotes，0.55 内建、零新依赖）；渲染层数学用 **Temml**（LaTeX→MathML，~35KB gzip，无字体）。
**B. 渲染层 KaTeX**（~280KB JS + ~300KB 字体资产，自绘 HTML）：功能最全，但 bundle 门禁（TOTAL_GZIP 1,615,000）与内存/首屏代价显著。
**C. 纯 TS 前置正则预处理** `$…$`：与 code span/转义/代码块的相互作用极易错，且违背「计算住 Rust」（ADR-0018）。
**D. 不支持**：内容不可读，验收方拒绝。

## 决定

**A**。理由：

- 解析是计算核职责：comrak 的 math/footnote AST 已内建，RenderNode 只新增两种 hast 形状（`span/div.math-*`、脚注 sup/section），serde JSON 契约面只增不改，parity corpus+snapshot 同步锁定。
- Temml 产出 **MathML**，WebView2（Chromium 153+）原生渲染，无需携带任何字体资产；Basel 类用例（\sum/\frac/\zeta/\pi）覆盖充分。KaTeX 的增量价值（ exotic 包、HTML 输出）在聊天场景不抵 4-8× 的 bundle/资产代价。
- 脚注形状对齐 remark-gfm/rehype（`user-content-` 前缀、`data-footnote-ref`、文末 `section[data-footnotes]`），维持管线「remark-rehype hast 投影」的形状哲学，corpus 的 `footnote-probe` 从「锁丢弃形状」转为「锁渲染形状」。

## 后果

- bundle：+temml（实测见 `check:bundle` 报告），js gzip 总预算按新实测重定标。
- 流式：未闭合 `$$` 以段落文本渐进，闭合后由 tail→stable 提升重解析自愈（与表格同语义）。
- 数学渲染失败回落 latex 原文（不抛错、不阻塞流）。
- 替代历史：parser.rs 模块注释「footnotes 刻意关闭……待裁决」由此裁决关闭；差异清单中 footnote 分叉项收敛。

## 证据

- comrak 0.55 `nodes.rs`：`NodeMath{dollar_math,display_math,literal}`、`FootnoteReference{name,ref_num}`、`FootnoteDefinition{name,total_references}`。
- comrak options 文档内建用例：cmark-gfm 脚注 HTML 形状（`fn-x`/`fnref-x`）——本管线改用 remark 的 `user-content-*` 前缀以对齐 remark-gfm。
- 实机：`F:\A-I\Platform\Pylon\pylon.exe`（0.2.6-Abc）MCP 实测公式裸奔（hasMathMl=false）。
