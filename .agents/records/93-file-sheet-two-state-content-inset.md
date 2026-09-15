# Dev Record — issue #93 FileSheet 两态正文容器右内边距统一

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/93-file-sheet-two-state-content-inset.md`

## 元信息

- issue：GitHub `AlchemistCxC/Pylon-co-works#93`（`bug(file-sheet)`：#69 收尾——正文容器右内边距两态不一致）
- 上游关联：#69（已关闭，PR #80 落地）；#83（共享词汇解耦，文件域相邻）；#101（本条施工侦察期发现并另立的解析回归，见 `.agents/records/issue-101-filesheet-comment-parse-regression.md`）
- 分支：`fix/issue-93-file-sheet-tails`（fork `hellochica/Pylon-co-works` → 上游 `main`）
- 基线：开工 `main @ 6c60bce`；施工中 `origin/main` 前进至 `d5c33f1a`（39 个提交），已 merge 进本分支（唯一冲突 `.agents/L.md`，见「并行交集」）
- 日期：2026-09-15
- 施工书：文档库《Pylon-Issue93-FileSheet两态几何收尾施工书-20260915.md》
- 工作副本：`F:\tool\Pylon-issue93`（独立 worktree；未触碰 `F:\tool\Pylon-main`、`F:\tool\Pylon-co-works-main`、`F:\tool\Pylon-issue69`）

## 目标与范围

**要达成**：FileSheet 只读态与编辑态的**正文容器（文本列）右内边距同值**，且同值由**同一构造**保证——宽行文件横向滚动到最右时两态右端留白一致；并为施工书 Q1–Q4 给出判定与证据。

**不做**（施工书 §1.3）：不改行号轨盒宽 56→72px（待作者裁断）；不碰 `src-tauri/**`、`.github/workflows/**`、`dist-plugin-sdk/**`、Markdown 渲染路径、#83 的共享词汇面；不重构、不顺手统一其它两态差异；不 force push、不 rebase 已推送分支、不直推 `origin`。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css` | 契约 token 块新增 `--file-code-content-pad-right: 0px`；共享正文容器规则新增 `padding-left: 0` / `padding-right: var(--file-code-content-pad-right)`；两态各自规则体删除水平内边距声明；契约注释补「正文右留白」算式 | 修改 |
| `src/sheets/file/__tests__/FileSheet.css.test.ts` | token 表登记新 token；新增 1 条断言（共享规则消费 token + 两态规则体不得自带水平内边距） | 新增 |

## 方案要点

### Q1「编辑态 16px 的承载选择器是谁」——用同一装置实测定位

**结论：上一轮记录里的「编辑 16px」不是正文容器的值，而是行盒（line box）的内边距被记到了容器头上。**

同一装置（headless Edge + CDP，5 类样本）实测的 computed 值：

| 元素 | 角色 | `padding-right` |
| --- | --- | --- |
| `.file-tab-pre` | 只读态正文容器 | **24px** |
| `.file-code-editor .cm-content` | 编辑态正文容器 | **0px** |
| `.file-tab-line` | 只读态行盒 | 16px |
| `.file-code-editor .cm-line` | 编辑态行盒 | 16px |

**真实级联溯源**（`CSS.getMatchedStylesForNode`，取每个元素命中的全部规则）：

- `.cm-content` 的水平内边距来源：`*` 重置（`index.css`，0）→ **CodeMirror 基础主题 `.ͼ1 .cm-content { padding: 4px 0 }`**（横向 0，vendor 注入）→ 契约块 `.file-code-editor .cm-content`（改前 `padding-right: 0`）→ 共享规则。
- `.cm-line` 的 16px 来源：contract 规则 `.file-tab-line, .file-code-editor .cm-line { padding: 0 var(--file-code-line-inset) }`。**这就是「16px」的承载者。**
- **Tailwind 层不参与**：`.file-sheet` 子树内没有任何 utility 形状的 class；`.cm-content` / `.cm-line` / `.file-tab-pre` 的命中规则里也没有一条 Tailwind 规则。`tailwind.css` 明确不引 preflight（全局 reset 由 `index.css` 承担），故几何前提不受 Tailwind 基线影响。
- **只读态 24px 的来源**（顺带溯源）：`fa4ef042`（#69 契约化）**之前**，文件里存在两条同名 `.file-tab-pre` 规则，靠「后者赢级联」生效：

  ```css
  .file-tab-pre { flex: 1; margin: 0; padding: 0 12px; overflow: visible; }   /* 旧块 A */
  …
  .file-tab-pre { …; padding: 12px 24px 32px 16px; … }                        /* 后者胜出 ⇒ 右 24px */
  ```

  #69 把生效值 24px 原样搬进契约块的字面量，编辑态则保持 0（CodeMirror 默认无横向内边距），于是这处两态差异在统一模型里留了下来——正是本 issue 要收的口。

### Q2「统一到哪个值」——判定：容器级 0px（由契约 token 持有）

三选一的代价对照：

| 取值 | 含义 | 代价 |
| --- | --- | --- |
| **0px（采用）** | 容器不加横向内边距，水平留白由行盒 `--file-code-line-inset` 单点承担 | 只读态少 24px 死留白；**编辑态 computed 完全不变**（改前改后都是 0） |
| 24px | 两态都补到 24px | 编辑态多 24px 尾部留白、横向可滚量 +24px；与容器已声明的 `padding-left: 0` 不对称 |
| 16px | 两态都补到 16px | **两态都变**，且 16px 就是行盒 inset 本身，等于把同一留白叠两遍 |

**理由**：两个容器本来就已经声明 `padding-left: 0`——水平内边距从一开始就由行盒承担（左：标记轨 2px + `--file-code-line-inset`；右：`--file-code-line-inset`）。把右侧也收成 0，模型才自洽：「**行盒管水平留白，容器不加料**」，两态同值由构造（同一条共享规则 + 同一个 token）保证，而不是两个数字碰巧相等。取 24 会让编辑态变得更宽（改的是用户真正输入的那个态），取 16 则两态都动且语义重复。

**A6 口径**：改后只有「正文容器右内边距」一处的计算样式变化（`.file-tab-pre` 24→0）；`.cm-content` 0→0 不变。

### Q3「亚像素 0.032px 是否值得动」——判定：**不修**

- 实测（`zz-wide.ts`，最宽行行盒右缘相对滚动内容原点）：只读 **4501.766** / 编辑 **4501.734**，Δ = **0.032px**，改前改后同值（本修复不触及它）。
- 成因：Blink 的 `LayoutUnit` 是 1/64 px，Δ = 0.032 ≈ **2/64**，来自 `max-content` 内在宽度在两条不同代码路径上的取整（`<pre>` 的 `min-width: max-content` vs CM 内容块）。
- 判定理由：0.032px 在任何缩放/DPR 下都不可见；要消除它必须把内容宽度改成显式计算（放弃 `max-content` 自适应），会带来真实回归风险而收益为零。属「登记不修」，已在 issue #93 与本记录留档。

### Q4「改动是否牵动横向滚动可用宽度 / 滚动条」——两环境改前/改后实测

样本 `zz-wide.ts`（超宽行），可用宽度 = `clientWidth − 纵向滚动条宽`：

| 环境 | 态 | clientWidth | scrollWidth | 横滚条 | 可用宽度 | 末字符后留白 |
| --- | --- | --- | --- | --- | --- | --- |
| 经典（`--disable-features=OverlayScrollbar,…`） | 只读·改前 | 830 | 4526 | 10 | 820 | 40 |
| 经典 | 编辑·改前 | 830 | 4502 | 10 | 820 | 16 |
| 经典 | 只读·改后 | 830 | **4502** | 10 | **820** | **16** |
| 经典 | 编辑·改后 | 830 | 4502 | 10 | **820** | **16** |
| 非经典（`--enable-features=OverlayScrollbar,…`） | 只读·改前 | 840 | 4526 | 0 | 840 | 40 |
| 非经典 | 编辑·改前 | 840 | 4502 | 0 | 840 | 16 |
| 非经典 | 只读·改后 | 840 | **4502** | 0 | **840** | **16** |
| 非经典 | 编辑·改后 | 840 | 4502 | 0 | **840** | **16** |

**结论**：可用宽度与滚动条占用在**两个环境下都零变化**（820 / 840 恒定，横滚条 10 / 0 恒定）；改动只把只读态的内容尾部 24px 收掉，使 `scrollWidth` 与编辑态一致（4526 → 4502）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| A1 两态正文容器右内边距同值（同装置、≥5 类样本、改前/改后数字） | ✅ 改前 24 / 0 → 改后 **0 / 0**；宽行样本末字符后留白 40/16 → **16/16**；见「证据」矩阵 |
| A2 §2.4 五项量不回退（Δ0px） | ✅ 行号轨盒宽 72/72、行号文字右缘 294/294、首字符 x 340/340、tab 列宽 14.297/14.297、经典滚动条可用宽度 820/820（改前改后同值） |
| A3 §2.3 亚像素项判定 | ✅ 判定「不修」+ 理由 + 复测证据（见 Q3） |
| A4 §6 门禁全绿、原始输出与退出码留档 | ✅ 见「证据」 |
| A5 行号轨盒宽未变（仍 72px） | ✅ 两态实测 72 / 72，`--file-code-gutter-width` / `--file-code-fold-width` 值未动 |
| A6 除正文容器右内边距外其余计算样式不变 | ✅ 见 Q2 口径；`padding-left` 两态均 0→0，`padding-top/bottom` 10/32 未动 |

## 测试处置

- `FileSheet.css.test.ts`（施工书 §7 例外 1 面）：**未删除、未改写、未放宽**任何既有断言；新增 1 条并登记新 token，套件 8 → 9 项。
  - 新增断言内容：共享正文容器规则必须含 `padding-right: var(--file-code-content-pad-right)` 与 `padding-left: 0`；且 `.file-tab-pre` / `.file-code-editor .cm-content` **各自的规则体**不得再出现 `padding-left` / `padding-right`。
  - 强度核验：把 `padding-right: 24px` 临时加回 `.file-tab-pre` ⇒ 新断言**失败**（报「不得自带水平内边距（会绕开共享 token）」）；去掉后**通过**。
  - 断言钉的是「两态同值由构造保证」，不是某个具体像素值。
- 未触碰 `FileTabView.edit.test.tsx` / `FileCodeEditor.test.tsx` 的行为锁；未改 `FileCodeEditor.tsx`（Q1 定位到 CSS 承载，不涉及编辑态接线）。

## 证据

**实测矩阵**（同一装置：headless Edge + CDP 驱动真实 app 浏览器演示模式，注入样本；5 类样本 × 两态 × 往返 2 轮，各轮同值）

样本集：`zz-plain.ts`（常规）/ `zz-long.ts`（1200 行）/ `zz-tab.ts`（含 tab）/ `zz-wide.ts`（600 字符超宽行）/ `zz-empty.ts`（空文件）

| 量 | 改前（RO / ED） | 改后（RO / ED） |
| --- | --- | --- |
| 正文容器 `padding-right` | 24px / 0px | **0px / 0px** |
| 宽行末字符后留白 | 40px / 16px | **16px / 16px** |
| scroller `scrollWidth`（宽行样本） | 4526 / 4502 | **4502 / 4502** |
| 行号轨盒宽 | 72 / 72 | 72 / 72 |
| 行号文字右缘 x | 294 / 294 | 294 / 294 |
| 首字符 x | 340 / 340 | 340 / 340 |
| tab 列宽（含 tab 样本） | 14.297 / 14.297 | 14.297 / 14.297 |
| 最宽行行盒右缘（亚像素） | 4501.766 / 4501.734 | 4501.766 / 4501.734 |
| 经典滚动条可用宽度 | 820 / 820 | 820 / 820 |

- 常规 / 1200 行 / 含 tab / 空文件四类样本：两态容器值改前即 24 / 0、改后 0 / 0，其余量全程 Δ0。
- 空文件无字符，故「首字符 x / 末字符留白」两列为 —。

**门禁**（§6 逐条，本机 Windows + bun，原始输出与退出码留档）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `bunx vitest run src/sheets/file` | exit 0，22 文件 / **149** 项（基线 147 + 本分支新增 2） |
| 2 | `bunx vitest run src/sheets/file/__tests__/FileSheet.css.test.ts` | exit 0，1 文件 / **9** 项（基线 7 + 2） |
| 3 | `bunx tsc -b` | exit 0，0 错误 |
| 4 | `bun run lint` | exit 0，0 error / 1 warning（既有 `RightRailHost.tsx:37`） |
| 5 | `bun run check:frontend` | 见 PR 正文（含首轮游走 flake 的如实登记） |
| 6 | Rust | 未改动；`src-tauri/**` 零触碰 |

**环境**：`bun install` → `545 packages installed [12.72s]`。施工书 §6 记的门禁基线（552 文件 / 3653 项）与实测（564 文件 / 3743 项）不符，属施工书自述允许的「基线已前进」，以实测为准。

## 与 spec 的偏差

1. **前置交付**：本 issue 的侦察必须先修复 #101（`FileSheet.css` 注释误闭合吞掉 `.file-sheet` 规则）。不修则 App 里没有横向滚动条，「宽行滚到最右」的观感面不存在，A1/Q4 无法实测。已单独登记 issue #101 并在 PR 正文单列。
2. **改 `padding-left`（一并收口）**：两态容器原本各自声明 `padding-left: 0`，本次把它与右侧一起收进共享规则。值零变化、级联特异度不变，属「同一处（内容容器水平内边距）」的构造收口，非施工书 §1.3 禁止的顺手重构。
3. **新增契约 token**：`--file-code-content-pad-right` 进 token 集（施工书 §5.1 的「唯一真源」），使两态同值可由测试断言，而非两个字面量。

## 未解问题

- 行号轨盒宽 56→72px 的外观取舍仍待作者裁断（施工书 §1.3 明令不得改动，本分支未动）。
- `.ͼ1 .cm-line`（CodeMirror 基础主题 `padding: 0 2px 0 6px`）与契约规则 **特异度相同**（0,2,0），当前靠契约块在文件/注入顺序上靠后取胜——#69 引入的「不再靠级联顺序」目标在此处仍有一条尾巴，属既有模型边界，本次未动（改动它会牵动 CodeMirror 装配，超出 §11.2）。

## 并行交集

- 触碰文件：`FileSheet.css`、`src/sheets/file/__tests__/FileSheet.css.test.ts`、`BOARD.md`、`.agents/L.md`、`.agents/records/`（两条记录）。
- **merge `origin/main`（`6c60bce` → `d5c33f1a`，39 提交）**：唯一冲突 `.agents/L.md`（双方都在文件尾追加留言）——按「取 main 版 + 追加回本人条目」解决，无内容丢失；`FileSheet.css` 与测试文件与 main **零重叠**。
- 与 #83 的交叉：只改同一文件里被 #83 改坏的注释与内容容器内边距；`SheetVocabulary.css` 零触碰。
- 未触碰：`F:\tool\Pylon-main`（#53 线）、`F:\tool\Pylon-co-works-main`（Chica/p55 线）、`F:\tool\Pylon-issue69`（#69 线）、Markdown 渲染路径、`dist-plugin-sdk/**`、`src-tauri/**`、`.github/workflows/**`。
