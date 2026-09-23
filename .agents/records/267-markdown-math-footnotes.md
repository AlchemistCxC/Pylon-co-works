# Dev Record — #267 markdown 数学公式渲染 + GFM 脚注补全

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/267
- 分支：`kumo/prometheus`（基线 = main `d360f9b0`，#257/#265 已合入）
- 提交：`3be0b280`（实现）+ docs/记录提交
- 日期：2026-09-23

## 目标与范围

实机验收发现 agent 回复中的 LaTeX 公式（`$…$`/`$$…$$`）全部裸文本呈现。全量盘点后确认两个内容缺口一次补全：**math（从未实现）** 与 **GFM 脚注（`[^n]` 引用+定义被解析侧整体丢弃=内容丢失，parser.rs「待裁决」项就此裁决，ADR-0021）**。不做：`math_code`、wikilink/描述列表/上下标（非 GFM）、HTML 放行（安全语义）、frontmatter（两侧一致）。

## 改动清单

| 文件 | 改动 | 性质 |
| --- | --- | --- |
| `pylon-markdown/src/parser.rs` | 开 `math_dollars`+`footnotes`；Math → `span/div.math(-display)`（remark-math 形状）；脚注两遍收集（首引用序编号 + 文末 section/ol/li/回链）；`Context` 增 footnotes 共享态；新增 6 条原生测试 | 修改 |
| `pylon-markdown/parity/{corpus,rust-snapshot}.json` | corpus 117→126 条；快照重生成 | 修改 |
| `src/components/chat/markdownFastPath.ts` | 补 MATH/FOOTNOTE 触发模式（否则纯公式段落/脚注被 fast path 直出丢结构） | 修改 |
| `src/renderers/solid-workbench/chat/mathRender.solid.tsx` | 新增：Temml → MathML 渲染组件 + `renderMathMarkup`（失败回落 latex 原文） | 新增 |
| `src/renderers/solid-workbench/chat/MarkdownContent.solid.tsx` | math/sup/section 特判；`a` 透传 id、纯锚点不再 `target=_blank`；通用路径透传 `id` | 修改 |
| `ChatView.css` | `.term-math(-display)`、`.term-footnotes`、`.term-footnote-ref`、`.term-math-raw` | 修改 |
| `package.json`/`bun.lock` | 新增 `temml@0.13.5` | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | markdown 行条目：GFM 扩展面 + parity 126 条 | 修改 |

## 方案要点（开源实现对照）

- **comrak 0.55 的 `$$` 恒为行内节点**（`tests/math.rs`：`$$\n2+2\n$$` → `<p><math>\n2+2\n</math></p>`）。对齐 remark-math 的 flow/text 区分：**整段仅一个显示公式（允许空白/软换行夹杂）提升为块级 `div.math-display`**，行中位置一律 `span.math-inline`——避免 div-in-p 非法嵌套。多个显示公式同居一段则保守不提升（各自 span）。
- **脚注编号**：第一遍文档序（先序）给名字编号（comrak 定义节点位于 root 尾部，其内部引用天然晚于正文）；未定义引用 comrak 不产节点、保持字面 `[^ghost]`（与 remark-gfm 一致）；未被引用的定义不进文末节（与 remark-rehype 一致）。
- **锚点形状**：remark-gfm/rehype 的 `user-content-*` 前缀；同名多引首个 `user-content-fnref-N`、后续 `-k` 后缀防重 id；回链恒指首引用锚，塞进定义末块内容尾。
- **Temml 选型**（ADR-0021）：LaTeX→MathML，gzip ~35KB、无字体资产（WebView2/Chromium 153 原生 MathML）；对比 KaTeX ~280KB JS+字体。`renderToString` 同步、`throwOnError:false` 失败渲染错误节点、异常兜底回落原文。
- **★ 渲染器文件命名坑**：新组件必须命名 `*.solid.tsx`——solid 插件 include glob 是 `/src\/renderers\/solid-workbench\/.*\.solid(?:\.test)?\.tsx$/`，普通 `.tsx` 会被 React transform 编译，Solid 组件在 React createElement 下渲染为字符串 `[object Object]`（实机+测试双复现后定位）。
- **★ fast path 触发表是解析能力的一部分**：`isPlainTextContent` 的模式表缺 math/footnote 时，纯公式段落与脚注文本被免解析直出（丢结构不丢字）。新增 MATH/FOOTNOTE 模式；误报代价仅为一次等价解析。
- **★ 本仓 waitFor 语义**：vendored `@testing-library/dom` 对「返回 null 的回调」**立即 resolve**，仅回调抛异常才重试——测试必须用 expect-throw 风格轮询，`querySelector` 裸返回式等待会假失败。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `cargo test -p pylon-markdown --lib` | ✅ 22/22（新增 math 行内/显示提升/行中 span、脚注引用+节/编号/未定义 6 条） |
| parity 门禁（corpus 126 条 vs 重生成快照） | ✅ 绿 |
| vitest 全量 | ✅ 632 文件 / 4797 passed / 0 failed（含新增 5 条 #267 渲染回归） |
| `check:solid` | ✅ rc=0 |
| `check:bundle` | ✅ 全过：js 总 gzip 1,471,253/1,615,000（+temml 无需重定标）；wasm 198,431/230,000 |
| fmt / clippy | ✅ 干净 / pylon-markdown 零警告 |
| **实机（MCP，release 0.2.6-Abc 重建版）** | ✅ Basel 会话：**67 行内 + 17 显示公式全渲染 MathML、裸 `$$` 残留 0**；显示块 `display="block"` 含 `mfrac`；textContent 出现 `∑/∞/ζ(2)/π²/1.644934` 数学符号；控制台仅存量 #250 ACL 警告 |

## 测试处置

- 新增：parser.rs 6 条形状钉子；`issue267.mathFootnotes.solid.test.tsx` 5 条渲染回归（行内/显示/fast-path 旁路/脚注链路/未定义字面）。
- 既有零修改：16 条 parser 测试与全部 TS 既有用例未动。

## 证据

- 实机 DOM 证据（F:\A-I\Platform\Pylon\pylon.exe，22:43 重建版）：
  `mathInline=67、mathDisplay=17、rawDollarLeft=0`；
  `.term-math-display math[display=block]` 含 `mfrac`，textContent=「S=∑n=1∞1n2=ζ(2)=π26≈1.64493406」。
- 修复前后对照：修复前同一会话 `hasMathMl=false、hasKatex=false`、`$$…$$` 全裸（见 issue #267 现状）。

## 与 spec 的偏差

- spec 预想「Math 显示态直接 div」——comrak 实测 `$$` 恒行内，改为「整段 solo 提升」规则（上文方案要点 1）。
- `a` 无 href 时回落 `span` 的既有行为保留（脚注引用 href 恒为 `#…` 走安全分支）；纯锚点链接不再 `target=_blank`（原地跳转，属脚注 UX 必需的行为修正，已登记）。

## 未解问题

- `artifacts/clippy-baseline.json` 两条 stale `runtime_log.rs` 路径条目（#262 已留档，不阻断）。
- 流式期未闭合 `$$` 以段落文本渐进（与表格同语义）；若未来要求流式期即渲染，需动 split 语义（另行评估）。

## 并行交集

本次触碰面见 L.md [2026-09-23 10] 条目；观察到 `scripts/`（#259 域）无冲突。

## 追加修复（2026-09-23 23:20，用户目视反馈「公式都是行内形态、不如 LaTeX 好看」）

实机 getComputedStyle 定位：`.term-math math` 被我初版 CSS 覆盖成 UI 无衬线字体栈（-apple-system/Segoe UI/PingFang），且 display 块字号与行内同为 15px——结构对、字体错，观感即「行内形态」。

修复（ChatView.css）：
- 数学字体栈改 `"Latin Modern Math", "STIX Two Math", "Cambria Math", math, serif`——装了 LM/STIX 用之，Windows 兜底自带的 **Cambria Math**（真数学字体）；不再继承 UI 字体
- `.term-math-display` 加 `font-size: 1.15em`（LaTeX display 体感）

复验（同一会话 MCP getComputedStyle + 截图）：displayFont=Latin Modern/STIX/Cambria 栈、display 17.25px/居中、`munderover` 上下限在位；截图目视 ∑ 上下限、分数、积分均标准 LaTeX 形态。Temml 自带 `Temml.woff2`（9.2KB 补字形）暂不引入——需要 url() 资产管道，若后续要像素级 Latin Modern 观感再上。

## 追加：字体资产 + 文档级排版层（2026-09-23 23:45，用户裁定「准许接入更多资产，目的是极致的数学观感、markdown 观感」）

**字体资产**（`public/fonts/`，随 frontendDist 内嵌进二进制；`.gitignore` 为 `public/*` 加精确豁免）：
- `LatinModern-Math.otf`（717K，CTAN `fonts/lm-math` 包）——LaTeX 同源数学字体，@font-face 族名 `LM Math Web`
- `Temml.woff2`（9.2K，temml 官方补字形，逐字回退兜底）

**公式字体栈**：`"LM Math Web" → "Latin Modern Math"（系统装了优先）→ "STIX Two Math" → "Cambria Math"（Windows 自带兜底）→ "Temml" → math → serif`。实机 `document.fonts.check('16px "LM Math Web"')=true` 且 computed fontFamily 首位即内嵌 LM——公式以 **LaTeX 原版字体**渲染。

**文档排版层**（`.term-assistant` 作用域，ChatView.css 末尾确定性赢级联）：标题分级尺度 + h1/h2 下边框；列表嵌套子弹（•/◦/▪，accent 色）+ 任务框 accent；引用 accent 左条 + 面板背板圆角；表格横线风 + 表头加重 + 行 hover；行内代码 pill；分隔线渐隐；图片限宽圆角；链接下划线偏移 + hover 加重。实机截图确认整体文档观感。

**门禁复核**：check:bundle 通过（wasm 206,291/230,000——含 #267 解析代码的最终 wasm）；check:first-party-styles、check:csp 绿；vitest 全量 632/4797 绿。字体不占 js/wasm 预算（随 dist 内嵌，二进制 +~730KB）。
