# Dev Record — issue #101 FileSheet.css 注释提前闭合导致 `.file-sheet` 规则被吞

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-101-filesheet-comment-parse-regression.md`

## 元信息

- issue：GitHub `AlchemistCxC/Pylon-co-works#101`（`bug(file-sheet)`：头部注释里的 `*/` 提前闭合注释，`.file-sheet` 规则被整条丢弃）
- 发现于：issue #93（FileSheet 两态几何收尾）施工期间的实测侦察
- 分支：`fix/issue-93-file-sheet-tails`（fork `hellochica/Pylon-co-works` → 上游 `main`）
- 基线：`main @ 6c60bce`
- 日期：2026-09-15
- 工作副本：`F:\tool\Pylon-issue93`（独立 worktree，未触碰 `F:\tool\Pylon-main`、`F:\tool\Pylon-co-works-main`、`F:\tool\Pylon-issue69`）

## 目标与范围

**要达成**：让 `FileSheet.css` 按书写意图解析——第 9 行的 `.file-sheet` 规则重新生效，sheet 外壳恢复两栏布局；并用一条断言把「注释提前闭合吞掉后续规则」这类回归钉住。

**不做**：不改任何 token 值、不改几何声明、不重排规则顺序、不调整两栏宽度；不触碰 #83 的共享词汇面（`SheetVocabulary.css`）、Markdown 渲染路径、`src-tauri/**`、`.github/workflows/**`、`dist-plugin-sdk/**`；不改既有的 7 条契约断言。

**与 #93 的关系**：#93 本体（正文容器右内边距两态统一）**不在本次提交内**。#101 是它的前置：没有横向可滚动的真实布局，就复现不出 #93 的观感面（「宽行滚动到最右」）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css` | 第 2 行头部注释：`file-main-*/` → `file-main-* /`（消除误闭合的 `*/`） | 修改（1 字符） |
| `src/sheets/file/__tests__/FileSheet.css.test.ts` | 新增 1 项断言：壳规则必须被解析出来 + 禁止注释残渣漏进选择器 | 新增 |

## 方案要点

**根因**：CSS 注释在**第一个** `*/` 处结束。第 2 行 `（file-main-*/file-section-title/hint/` 里的 `*/` 提前收尾，其后的中文说明被当作代码解析；解析器在顶层按「选择器序言 → `{` → 声明块 → `}`」消费，于是把第 9 行 `.file-sheet {` 的整个声明块当成了这条垃圾规则的主体，规则整体判无效丢弃，直到第 17 行 `.file-sidebar` 才恢复。

**修法**：只去掉那个 `/`（`file-main-*`），保持注释语义不变，注释内不再出现 `*/`。

**回归断言**（新增，非改写既有断言）：
1. 用测试文件里既有的非贪婪剥离解析器（与浏览器同口径）取出 `.file-sheet` 规则，断言它存在且体内含 `display: flex` / `flex: 1`——**改前该断言失败**（取到的是第 331 行那条只有 `background` 的 `.file-sheet`）；
2. 通用护栏：任何被解析出的规则，其选择器不得含 `*/` 或 CJK 字符（注释残渣漏进选择器的特征）。

**强度核验**：把 CSS 临时回退到 `HEAD`（改前）跑该断言 —— 失败；恢复修复后 —— 通过。7 条既有断言全程未改动，强度只增不减。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| A1 壳规则被解析（改前失败 / 改后通过） | ✅ 改前 `shell.body` 取到 `background: var(--bg-panel)` → `display: flex` 断言失败；改后通过 |
| A2 真实布局恢复两栏 + 横向滚动可用 | ✅ 见证据表 |
| A3 §6 门禁全绿、原始输出与退出码留档 | ✅ 见证据 |
| A4 改动面 ⊆（`FileSheet.css` + file 域测试） | ✅ 2 文件，1 字符 + 18 行测试 |
| A5 既有断言零改动、零删除、零 skip | ✅ `FileSheet.css.test.ts` 由 7 项 → 8 项 |

## 测试处置

- 未删除、未改写任何既有断言；`FileSheet.css.test.ts` 新增 1 项（7 → 8 项）。按 `AGENTS.md §3.3` 例外 1 的口径属**强度增加**，无「契约承载迁移」。
- 未触碰 `FileTabView.edit.test.tsx` / `FileCodeEditor.test.tsx` 的行为锁。

## 证据

**实测矩阵**（headless Edge `--headless=new` + CDP 驱动真实 app 浏览器演示模式；同一装置、同一样本 `zz-wide.ts`（含超宽行）、改前改后各跑一遍；脚本 `evidence93-layout.js`）

| 量 | 改前（`main @ 6c60bce`） | 改后 |
| --- | --- | --- |
| FileSheet.css 解析规则数 | 324 | 325 |
| 前 3 条选择器 | `.file-sidebar` / `.file-sidebar.collapsed` / `.file-sidebar-panel` | `.file-sheet` / `.file-sidebar` / `.file-sidebar.collapsed` |
| `.file-sheet` 规则体 | `background: var(--bg-panel);`（仅第 331 行那条） | `flex: 1 1 0%; display: flex; min-width: 0px; color: var(--text); font-family: var(--font);` |
| `.file-sheet` computed `display` | `block` | `flex` |
| 侧栏 left/width | 0 / 250 | 0 / 250 |
| 编辑器 left/width | 0 / 4501.73（与侧栏同 left ⇒ **堆叠**） | 250 / 840（**并排**） |
| scroller `clientWidth` | 4502 | 830 |
| scroller `scrollWidth` | 4502 | 4502 |
| 横向滚动条高度 | 0 | 10 |
| `scrollWidth − clientWidth` | 0（**不可横向滚动**） | 3672 |

- 其余量（gutter 盒宽 72、`.cm-content` padding 0/0、首字符 x）两态一致且未变——本修复不产生几何值变化，只恢复布局。
- **最小复现**（同文档内建 `<style>` 验证解析行为）：原样放入头部注释 ⇒ 紧随的探针规则丢失；`file-main-*/` → `file-main-*` ⇒ 探针规则存活。
- 改前截图与改后截图各一张（同装置、同样本），见 PR 正文。

**门禁**（§6 逐条，本机 Windows + bun，原始输出与退出码留档）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `bunx vitest run src/sheets/file` | exit 0，22 文件 / **148** 项（基线 147 + 本次新增 1） |
| 2 | `bunx vitest run src/sheets/file/__tests__/FileSheet.css.test.ts` | exit 0，1 文件 / **8** 项（基线 7 + 1） |
| 3 | `bunx tsc -b` | exit 0，0 错误 |
| 4 | `bun run lint` | exit 0，0 error / 1 warning（既有 `RightRailHost.tsx:37`，非本次引入） |
| 5 | `bun run check:frontend` | exit 0（全链） |
| 6 | Rust | 未改动；`src-tauri/**` 零触碰 |

**环境安装**（施工书 §必读二要求回报）：`bun install` → `545 packages installed [12.72s]`，无 warning、无失败。

## 与 spec 的偏差

1. **本任务原定交付是 #93 的右内边距统一**，实际交付的是其前置解析回归（#101）。原因见下，已由用户当场裁断（「只在本分支修且顺带登记 issue」）。
2. **越出 §5.6「视觉冲击仅限正文容器右内边距一处」**：本修复让 `.file-sheet` 的计算样式从 `block` 回到 `flex`，视觉上是整个 sheet 外壳的恢复。理由是：不修则 #93 的观感面（横向滚动）在真机上根本不存在，实测矩阵只能建在一个坏布局上；且交付后用户看到的仍是坏布局。已在 PR 正文向作者单列说明。
3. **issue 登记归属**：#101 由施工员代为登记（施工书 §10.4 的默认路径是 BOARD 登记；登记 issue 属用户当场授权），非作者原派任务。

## 未解问题

- **#93 本体未做**：正文容器右内边距两态统一（只读 `.file-tab-pre { padding-right: 24px }` / 编辑 `.cm-content { padding-right: 0 }`）连同 Q1–Q4 的判定与实测矩阵仍待办。本次实测已顺带确认一条：编辑态 `.cm-content` 的 computed `padding-right` 是 **0px**（非记录里的 16px），记录中的「16px」需按同一装置复核承载者后另做。
- **亚像素项**（超宽行行盒右缘 3000.266 / 3000.234）未动。

## 并行交集

- 触碰文件：`FileSheet.css`、`src/sheets/file/__tests__/FileSheet.css.test.ts`、`BOARD.md`、本记录。
- 与 #83 的交叉：`FileSheet.css` 的头部注释正是 #83 改写出来的；本次只修注释的误闭合，不动 #83 搬走的共享词汇（`SheetVocabulary.css` 零触碰）。
- 未触碰：`F:\tool\Pylon-main`（#53 线）、`F:\tool\Pylon-co-works-main`（Chica/p55 线）、`F:\tool\Pylon-issue69`（#69 线，已合并）、Markdown 渲染路径、`dist-plugin-sdk/**`、`src-tauri/**`、`.github/workflows/**`。
