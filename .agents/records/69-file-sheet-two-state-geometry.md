# Dev Record — issue 69 FileSheet 两态几何统一模型

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/69-file-sheet-two-state-geometry.md`

## 元信息

- issue：GitHub `AlchemistCxC/Pylon-co-works#69`（`bug(file-sheet)`：切换编辑/只读态时文件内容轻微偏移，最左行号列整体位移）
- 分支：`fix/issue-69-file-sheet-geometry`（fork `hellochica/Pylon-co-works` → 上游 `main`）
- 提交范围：`b562e8a..<head>`
- 日期：2026-09-14
- 规格：文档库《Pylon-Issue69-FileSheet两态几何统一模型施工书-20260913.md》（用户交付的施工书即本任务 spec；未另建 `.agents/spec/` 条目）
- 工作副本：`F:\tool\Pylon-issue69`（独立 worktree，未触碰 `F:\tool\Pylon-main`、`F:\tool\Pylon-co-works-main`）

## 目标与范围

**要达成**：FileSheet 代码文件视图在只读 ↔ 编辑两态往返时，首字符基线、行号列、行盒、tab 列宽**零漂移**，且零漂移由**一个统一几何模型从结构上保证**（作者口径：建立新的统一模型而不是追加补丁，不再依赖“契约块恰好在文件末尾所以赢了级联”）。

**不做**：Markdown 渲染路径（`.file-tab-md`）；`dist-plugin-sdk/**`、`src-tauri/**`、`.github/workflows/**`；砂纸 #67/#68 批次预告面；两个既有工作树；无关重构与格式化。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css` | 旧块 A/B 与编辑块的几何声明剥离；文末契约块升级为双轨 token + 分组选择器（唯一真源）；变更行标记改不占布局画法 | 修改 |
| `src/sheets/file/FileCodeEditor.tsx` | CodeMirror 装配：从契约 token 读 tab 列宽写入 `EditorState.tabSize` | 修改 |
| `src/sheets/file/__tests__/FileSheet.css.test.ts` | 契约测试升级：token 集 / 双轨模型 / **无旁路**断言 | 修改 |
| `src/sheets/file/__tests__/FileCodeEditor.test.tsx` | 新增 tab 列宽 token 接线与 Tab 键无编辑语义的行为锁 | 修改 |

## 方案要点

**统一模型（导轨模型）**：两态几何的全部真源 = 契约块的 token 集 + 分组选择器。

- 盒宽 = `--file-code-gutter-width`(56px) + `--file-code-fold-width`(16px)；
- 行号右缘 = 盒左 + 行号轨宽 − `--file-code-gutter-pad-right`(12px) ⇒ 两态同为 44px；
- 首字符左缘 = 盒左 + 盒宽 + `--file-code-mark-rail`(2px) + `--file-code-line-inset`(16px)；
- tab 列宽 = `--file-code-tab-size`(2)，只读态走 CSS、编辑态走 `EditorState.tabSize`。

关键决策与实测依据：

1. **折叠轨显式化**（施工书未预见项）：`basicSetup` 含 `foldGutter`，编辑态 `.cm-gutters` 盒里同时有行号列与折叠列，两列都按内容定宽 ⇒ 行号文字右缘实测比只读态**左移 16.078px**（1200 行文件为 6.406px，因为折叠列被行号挤窄）。模型把折叠轨声明成固定 token 轨，**只读态同样预留**，两态行号列因此由构造相等（行号区可用宽度也从“内容相关”变为恒等 36px）。
2. **分隔线改 inset 阴影**：`border` 会吃掉盒内 1px 布局宽度，让只读态行号右缘比编辑态少 1px；同时 vendor 基础主题自带一条 `.cm-gutters-before{border-right-width:1px}`（实测吃了折叠轨 1px 并用自己的灰色）。契约显式 `border: 0` + `box-shadow: inset -1px 0 0`，两态分隔线位置/颜色同源。
3. **2px 标记轨两态对称预留**：只读态 `.file-tab-line` 的 `border-left: 2px`（变更行标记载体）不再“穿透契约”，编辑态 `.cm-line` 同宽透明轨 ⇒ 首字符左缘差从 2px 归零。
4. **行装饰不占布局**：变更行 `::before` 圆点改为绝对定位（行盒 `position: relative`），改前实测变更行正文比未变更行右移 **13.156px**（圆点 7.156px + `margin-right: 6px`），改后为 0。
5. **tab 列宽注入走 state 而非 CSS**：CodeMirror 用 `tabSize` 同时计算「tab 渲染宽度」与「坐标 ↔ 偏移」换算，只在 CSS 覆盖会让含 tab 的行点击/选区错位。装配时从宿主元素计算样式读 token（jsdom 读不到时回退常量，常量值由契约测试锁定与 CSS 一致）。本编辑器未装配 `indentWithTab`（CM 默认 keymap 亦不含 Tab），实测 Tab 前后文档不变 —— 该前提已用测试钉住。
6. **无旁路**：契约块之外，投影选择器的每一条规则体都不得声明几何属性（测试对**每条**规则体做属性黑名单断言，而非只查最后一条同名规则）。

**披露的视觉变化**：行号轨盒宽 56 → 72px（为折叠轨预留），两态正文左缘同比右移 16px；只读态从 350px → 366px，编辑态 348px → 366px。这是让折叠列不再偷吃行号列宽、且两态由构造相等的代价；两态内部节奏（行号右缘到正文间距）保持不变。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| M1 实测矩阵（5 类样本 × 两态 × 往返 ≥2 轮：gutter 盒宽 / 行号右缘 x / 首字符 x / 首行基线 y / tab 列宽，全差值 0px） | ✅ 全 0（表见「证据」） |
| M2 契约收口（两态几何各只一处权威来源 + 无旁路断言） | ✅ 契约块单点 + 7 项测试含 no-bypass |
| M3 行为保全（变更行标记可见不劣化 / revealLine / save-anchor / 脏行集合 / `data-file-code-layout="shared"` / Markdown 路径零改动） | ✅ file 域 22 文件 147 项全绿 |
| M4 门禁（§6 全绿、0 新增 lint warning） | ✅ tsc 0 / lint 0 error / check:frontend 退出码 0 |
| M5 不回退（354eb472 的行号右缘对齐不得回退） | ✅ 两态 44px（且由 token 保证，不再靠 vendor 巧合） |
| M6 边界（禁改面零触碰、BOARD 登记完成） | ✅ 见「并行交集」 |

## 测试处置

- **未删除任何既有测试**。
- `FileSheet.css.test.ts`（例外 1，强度不降）：原 4 项断言中「两态同 token / 行号列 12px 右内边距 / `.cm-gutters .cm-gutter{flex:1 1 auto}` / 行盒与左内边距 token」随模型演进改写为新断言集（token 全量 + 双轨模型 + 无旁路 + 旧补丁已下线），断言从“只查最后一条同名规则”升级为“逐条规则体属性黑名单”。
- `FileCodeEditor.test.tsx`：新增 2 项（tab 列宽 token 接线与回退路径；Tab 键无编辑语义的行为锁），未动既有 3 项。

## 证据

**M1 实测矩阵**（真实浏览器 = headless Edge 驱动真实 app 的浏览器演示模式，注入脚本仅用于追加样本文件；同一装置改前/改后各跑一遍，每态量测 3 次：打开即编辑、往返第 1 轮、第 2 轮，各轮同值）

| 样本 | gutter 盒宽 (RO/ED) | 行号右缘 x | 首字符 x | 首行基线 y | tab 列宽 |
| --- | --- | --- | --- | --- | --- |
| 常规代码文件 | 56 / 56 → **72 / 72** | 319 / 302.922 → **320 / 320** | 350 / 348 → **366 / 366** | 196 / 196 → **196 / 196** | — |
| >1000 行（1200 行，4 位行号） | 56 / 56 → **72 / 72** | 319 / 312.594 → **320 / 320** | 350 / 348 → **366 / 366** | 196 / 196 → **196 / 196** | — |
| 含 tab 缩进 | 56 / 56 → **72 / 72** | 319 / 302.922 → **320 / 320** | 350 / 348 → **366 / 366** | 196 / 196 → **196 / 196** | 14.297 / 28.594 → **14.297 / 14.297** |
| 超宽行（400 字符） | 56 / 56 → **72 / 72** | 319 / 302.922 → **320 / 320** | 350 / 348 → **366 / 366** | 196 / 196 → **196 / 196** | — |
| 空文件 | 56 / 56 → **72 / 72** | 319 / 302.922 → **320 / 320** | —（无字符） | — | — |

（RO = 只读态，ED = 编辑态；“→”左侧为改前、右侧为改后）

- **改动前**：首字符 x 差 **−2px**（RC1）；行号右缘差 **−16.078px**（常规/含 tab/超宽/空文件，1200 行文件 **−6.406px**）；tab 列宽 **2 倍差**（RC2）；行盒高 19.5px、首行基线 y 196px 两态一致。
- **改动后**：五类样本的全部指标差 **0px**，且每个状态的 3 次量测完全同值（往返无累积漂移）。
- **滚动条项（RC3 附带）**：经典滚动条环境（`--disable-features=OverlayScrollbar…`）下 1200 行文件，改前只读 `scrollbar-width: thin` 10px / 编辑态 4px（可用宽度差 6px），改后两态同 10px、Δ0；headless 默认 overlay 滚动条环境两态均为 0。契约已把 `scrollbar-width: thin` 同时声明给 `.file-tab-view` 与 `.cm-scroller`。
- **行装饰**：变更行与未变更行、与编辑态的首字符 x —— 改前 363.156 / 350 / 348（变更行右移 13.156px），改后 **366 / 366 / 366**；圆点仍可见（`::before` content `·`、position absolute、margin-right 0）。
- **未纳入本轮（量化登记）**：正文容器右内边距只读 24px / 编辑 16px（不影响左缘 x、首字符与行盒起点；宽行时行盒右缘 3000.266 vs 3000.234，差 0.032px 属 max-content 亚像素取整）。

**门禁**（§6 逐条，本机 Windows + bun，原始输出与退出码已留档）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `bunx vitest run src/sheets/file` | exit 0，22 文件 / 147 项通过，0 skip |
| 2 | `bunx vitest run src/sheets/file/__tests__/FileSheet.css.test.ts` | exit 0，1 文件 / 7 项通过（含无旁路断言） |
| 3 | `bunx tsc -b` | exit 0，0 错误 |
| 4 | `bun run lint` | exit 0，0 error / 1 warning（既有 `RightRailHost.tsx:37`，非本次引入） |
| 5 | `bun run check:frontend` | exit 0（552 文件 / 3653 项测试、覆盖率、构建、bundle、solid-smoke、docs、deps 全链） |
| 6 | Rust | 未改动；`src-tauri/**` 零触碰 |

**提交**：见本分支 commit 列表（代码与测试分片提交，显式 `git add <路径>`）。

**手工验证**：headless Edge + CDP 驱动真实 app（`F:\tool\Pylon-issue69` 的 vite dev server + 浏览器演示模式），样本文件由会话内注入脚本提供（harness 为临时文件，未入库）。

## 与 spec 的偏差

1. **施工书 §2.3 未预见折叠列**：模型新增 `--file-code-fold-width` 轨（施工书 Q1「有无额外贡献项」的答案），并据此把 gutter 盒宽从 56px 扩到 72px（披露的视觉变化，见「方案要点」）。
2. **施工书 §12.1 步骤 3 的两个候选**：RC1 采用「两态对称预留 2px 标记轨」；标记圆点额外改为不占布局的绝对定位（属“行装饰同源”，与 §2.4 RC3 作者口径一致）。
3. **tab 列宽**（Q3）：值取只读态的 2，编辑态走 `EditorState.tabSize` 注入而非 CSS 覆盖（CSS 覆盖无法越过 CM 的内联样式，且会与 CM 的坐标换算脱节）。
4. **无 `.agents/spec/` 条目**：本任务 spec 由用户交付的施工书充当（施工书在仓库外文档库）。
5. **BOARD 登记**：按施工书 §10.7 写 root `BOARD.md`；同时按仓库新规范 `AGENTS.md §2.4` 补本开发记录。

## 未解问题

- 正文容器右内边距 24px/16px 的差异保留（施工书 Q4 项）；如需统一，改动面涉及宽行横向滚动的观感，建议单独立项。
- 折叠轨宽 token 取 16px（vendor 折叠列自然宽约 16.078px）；若后续 CM 版本改变折叠列默认度量，token 仍是唯一真源。

## 并行交集

- 触碰文件：`FileSheet.css`、`FileCodeEditor.tsx`、`src/sheets/file/__tests__/FileSheet.css.test.ts`、`src/sheets/file/__tests__/FileCodeEditor.test.tsx`、`BOARD.md`。
- 未触碰：`F:\tool\Pylon-main`（#53 线）、`F:\tool\Pylon-co-works-main`（Chica/p55）、砂纸 #67/#68 批次预告面、Markdown 渲染路径、`dist-plugin-sdk/**`、`src-tauri/**`、`.github/workflows/**`。
