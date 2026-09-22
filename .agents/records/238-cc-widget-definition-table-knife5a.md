# Dev Record — #238 刀5A 项收尾（三项状态类字段删除 + 提示字号归位）

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\元件定义表\07-施工单-刀5-项与名单收尾.md`（§0~§3 + 完工回填 §6）
> 规范：同目录 `00-施工规范-中控元件定义表-v1.0.md` §7 / §11.7；分支 `feat/cc-widget-definition-table`（刀1~刀5 同分支）

## 元信息

- issue：[#238](https://github.com/AlchemistCxC/Pylon-co-works/issues/238)
- 分支：`feat/cc-widget-definition-table`（未 push、未开 PR；远端保持刀4 终点）
- 提交范围：`5bd5727e..61267ea1`（`5bd5727e` L.md 声明 → `61267ea1` 实现）
- 日期：2026-09-22

## 目标与范围

原「信息行」名下三项的收尾（用户 2026-09-22「确定状态信息全删了」，翻译裁定见施工单 §6.2）：

1. `statusBg` / `statusBgImage`（状态区背景 / 背景图）—— **直接删除**（不是标记废弃）；
2. `ccStatusFontSize`（状态信息字号）—— 删除，字号落到**元件自己**：信息行固定 16px + 命令行提示新增自己的字号字段；
3. 「状态信息」设置分组**整组消失**；「输入与状态」组**保留**、只减 2 项（12 → 10）；
4. 出厂数据手改（生成脚本已删，只能手改）+ 契约快照重拍 + 系统字段桶更新。

**不做**（明确冻结，等刀5B 的单子）：命令行提示升格（`draggable` 翻 true、`renderBody` 分支、删裸渲染
`commandHint()`、编辑工具条 6→7、计数/分隔点排除、CSS 适配）。本轮**一行未动**，原因见「与 spec 的偏差」第 1 条。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/themeFieldDefs.ts` | 删 `ccStatusFontSize` / `statusBg` / `statusBgImage` 三条定义；新增 `ccHintFontSize`（「快捷提示字号」，12–22，默认 16，`cssVar: --cc-hint-font-size`，归「控件样式」）；`GROUP_ORDER.cc` 删空掉的「状态信息」组登记 | 修改 |
| `src/store.ts` | `ThemeSettings` 类型同步（删 3、加 `ccHintFontSize`） | 修改 |
| `src/domains/cc/widgetDefinitions.ts` | `cc-command-hint/hint-line` 成员字段 `cliHintMode` → `+ccHintFontSize`；`CC_SYSTEM_FIELDS` 6 → 3（只剩三份名单本体） | 修改 |
| `src/domains/theme/themeCssSnapshot.ts` | 删派生变量 `--status-bg-image`（`--status-bg` 由字段表循环自动消失） | 修改 |
| `src/domains/workbench/workbenchSkinContract.ts` | `WORKBENCH_DERIVED_CSS_VARIABLES` 与 `resolveCssVariables` 各删 `--status-bg-image` | 修改 |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css` | `.cc-status-row` / `.cc-footer-status-row` 行字号 `max(14px, var(--cc-status-font-size,14px))` → 固定 `16px`；`.cc-command-hint` 字号 `0.86em` → `calc(var(--cc-hint-font-size, 16px) * 0.86)` | 修改 |
| `src/zones/factory/terminal-cc.ts` | 删 15 行（`ccStatusFontSize` ×5 + `statusBg`/`statusBgImage` 各 ×5）；补 `ccHintFontSize: 16` ×5 | 修改 |
| `src/zones/factory/gui-cc.ts` | 删 3 行（同上各 ×1）；补 `ccHintFontSize: 16` ×1（`solarized`） | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 脚本重拍（不是手改） | 修改 |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 不变量计数同步（见「测试处置」） | 修改 |
| `src/__tests__/presets.test.ts` | 换同形样本字段 | 修改 |
| `src/__tests__/effectivePresetTheme.test.ts` | 字段数基线按**真值**重算 | 修改 |

## 方案要点

1. **「全删」的准确含义**（施工单 §0 表）：三个字段全删 ⇒ ①「状态信息」组只有 `ccStatusFontSize` 一项，删了整组消失；
   ②「输入与状态」组里还有 10 个输入栏字段，**只减最后两项**、**不删整组**（实机复核：该组确为 10 项）。
2. **字号归位（外观零变化的做法）**：信息行的**行字号**是分隔点 / 空态控件的字号来源，所以把它**固定成原解析值 16px**
   （`max(14px, 16px)` = 16）；命令行提示则拿自己的字段（默认 16）配 `× 0.86`，折算结果 13.76px = 改造前原值。
3. **`statusBg` 的双重角色（施工单停手条件 1）**：它除了是僵尸字段，还挂着 `semanticRole: 'surface.panel'` +
   `semanticSource: true`，是 `--surface-panel` 的兜底源之一（在 `themeFieldDefs` 定义序里排第 4）。
   ⇒ **删前删后逐条比对解析值**，见「证据」第 1 行：**15/15 fixture 零差异**。
4. **出厂数据只能手改**：数据文件头就写着「生成脚本已于刀3 删除，请勿手改」，本刀是**被授权的例外**
   （施工单 §0-4）。删键之外还要**补** `ccHintFontSize`：`terminalPresets.test.ts` 要求每套终端预设
   「覆盖全部主题字段」，而新增字段不在出厂数据里就缺键（见「与 spec 的偏差」第 2 条）。
5. **新字段为何要进预设**（翻译 §6.2 否决了「非主题字段」方案）：字段落在 `cc` zone ⇒ 自动进
   `PRESET_ZONES` ⇒ 每套出厂预设的该区切面必须带上它，否则「预设管不到提示的字号」。
   补的是那 6 套**完整快照**型出厂条目（5 套 terminal + `gui/solarized`，它们的 cc 切面本就有 `cliHintMode`）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| ★ `--surface-panel` 解析值不变（停手条件 1） | ✅ 15 套 fixture **逐条相同**（零差异）；CSS 变量集合恰好 **−3 / +1** |
| 契约快照重拍 + 逐条 diff | ✅ 净 **−2 字段 / −2 变量**；`themeSettingCount` 191→**189**、`cssVariableCount` 98→**96**；15/15 fixture 一致；只多 `generatedAt` 一行 |
| 出厂数据补键对快照的影响 | ✅ **零影响**（`ccHintFontSize: 16` == 默认值 ⇒ fixture 逐字节不变，只差 `generatedAt`） |
| 实机 零外观变化（**free**，改造前后） | ✅ 逐项相同（见「证据」第 3 行） |
| 实机 **peri**（改造前后） | ⚠️ 提示字号 **12.9 → 13.76px（+0.86px）**，箱高 +1.16px；分隔点 **15px 不变**、个数不变（见「与 spec 的偏差」第 3 条，翻译裁定接受） |
| 设置页实机核验 | ✅「状态信息」分组消失；三项中文文案全页不存在；「输入与状态」= **10 项**；「快捷提示字号」落在「控件样式」 |
| 门禁五步 | ✅ `lint`（0 error）/ `build:example-plugin` / `build` / `check:solid` / `test` 全绿 |
| 全量测试 | ✅ **627 文件 / 4743 通过 + 1 todo**（含预设线那两条） |
| 反向验证 | 本轮**无新增测试**（只改既有断言/基线）⇒ 按口径「改断言/改夹具不重做」；改断言前后取过**红→绿**对照，见「测试处置」 |
| 开发记录 | ✅ 本文件 |
| 《中控元件总表》更新 | ✅ 仓外 `E:\Acode\FILES\任务\工作台优化\中控元件总表.md` |
| issue #238 回写 | ✅ 见评论区 |

## 测试处置

逐个列出（**全部是「契约变更引起的写法同步」，没有删行为覆盖**）：

1. `src/domains/cc/__tests__/widgetDefinitionTable.test.ts`（施工单 §1 必跑清单内）——
   `ccFields` **83 → 81**；系统桶 **6 → 3**；总数 **83 → 81**；「命令行提示」组字段 **1 → 2**；
   成员归属表 `'cc-command-hint/hint-line'` 加 `ccHintFontSize`。
2. `src/__tests__/presets.test.ts` —— 原 `ccStatusFontSize zone 归属契约` 4 条（样本字段已删）**改用
   仍存在的 `inputFontSize` 作同形样本**，锁的还是「zone 归属唯一 / 字段序契约 / `pickZoneFields` 只切本区」；
   字段序断言同步为 `ccBgImage < inputTextColor < inputFontSize`（原样本删后该位置已无字段）。
3. `src/__tests__/effectivePresetTheme.test.ts` —— `BASELINE_FIELD_COUNTS` 按**新真实键数**重算：
   6 套完整快照型 **191 → 189**（`−3 删 + 1 加`），`glass` **69**、`agent-*` 三套 **36** 不变；
   注释里写明每套为什么是这个数（真值由 `.agents/spec/238-刀5-probe-preset-counts.mts` 跑出，**不是猜的**）。

**未修改**：`B-01-visual-semantic-palette.test.ts`、`themeFieldCopy.test.ts`、`factoryZonePresets.test.ts`
（50 条出厂条目对拍）—— 三条**都保持绿、零改动**。

## 证据

- **commit**：`61267ea1`（12 文件，+100/−151）；`git status` 干净；**未 push、未开 PR**。
- **① `--surface-panel` 解析值（停手条件 1 的反证）**：探针 `.agents/spec/238-刀5-probe-surface-panel.mts`
  在改动前后各跑一次（改动前用 `git stash push -- src/` 取），逐条 diff：

  ```
  ### --surface-panel 逐条 diff（before vs after）:
    → 无差异（逐条相同）                    # 15/15 fixture
  ### 变量名集合 diff（default fixture）:
  7a8   > --cc-hint-font-size
  25d25 < --cc-status-font-size
  94,95d93 < --status-bg
  96d94  < --status-bg-image
  ### cc zone 字段数:  83 true true  →  81 false false
  ```

- **② 契约快照**：`bun scripts/check-workbench-theme-contract.mts --write` →
  「主题字段 **189** 个；Workbench CSS variables **96** 个；fixture 15 个」；diff 归类：

  ```
  15 fixtures 各删 "ccStatusFontSize"/"statusBg"/"statusBgImage"、各加 "ccHintFontSize"
  15 -"--status-bg-image"(*)   15 -"--cc-status-font-size"(*)   14 -"--status-bg"(*)   15 +"--cc-hint-font-size"(*)
  -"themeSettingCount": 191  +189      -"cssVariableCount": 98  +96
  （* 含各 1 条越界样本：statusBg "#abcdef"/""、字号 20/14、提示字号 22/12）
  ```

- **③ 实机 零外观变化（free 模式；普通 `cargo build` 二进制 + WebView2 调试端点）**：

  | 测项 | 改造前 | 改造后 |
  | --- | --- | --- |
  | 信息行行字号 | 16px | 16px |
  | 信息行盒 | 896 × 46.57 @ (277, 735.43) | 同 |
  | 提示字号 / 盒 | 13.76px / 873.6 × 18.57 @ (299.4, 761.43) | **同** |
  | 提示父节点 / 文案 | `.cc-status-row` / `/: 命令\| Shift+Enter: 换行` | 同 |
  | 分隔点 数量/字号/盒 | 3 / 16px / 24.8 × 21.59 @ (423.4, 738.63) | 同 |
  | 信息组元件 | model, reasoning, mode, tokens | 同 |
  | `--cc-hint-font-size` | 未注入 | 16px（折算仍 13.76px） |
  | `--cc-status-font-size` / `--status-bg` / `--status-bg-image` | 有 | 全部消失 |

- **④ 实机 peri 模式（施工单 §6.1 点名补测；真实 peri 渲染路径，非模拟）**：

  | 测项 | 改造前 | 改造后 | 差 |
  | --- | --- | --- | --- |
  | `.cc-body` 继承字号 | 15px | 15px | — |
  | **提示字号** | **12.9px** | **13.76px** | **+0.86px** |
  | 提示盒 | 896 × 17.41 @ (277, 762.59) | 896 × 18.57 @ (277, 761.43) | 高 +1.16px |
  | 提示父节点 / `flex-basis` / `width` | `.cc-footer-status` / auto / 896px | 同 | — |
  | 分隔点 数量/字号/盒 | 3 / **15px** / 19.26 × 20 @ (401, 740.59) | 3 / **15px** / 19.26 × 20 @ (401, 739.43) | 字号不变、仅随行高整体上移 |
  | 状态列 `.cc-footer-status` | 896 × 45.41 @ (277, 736.59) | 896 × 46.57 @ (277, 735.43) | 高 +1.16px |

- **⑤ 门禁五步**：

  ```
  lint             → ✖ 1 problem (0 errors, 1 warning)   # 警告在他人文件 RightRailHost.tsx，非本刀
  build:example-plugin → [build-example-plugin] dist/entry.js + dist/styles.css + dist/entry.d.ts 已由 src/ 重建
  build            → ✓ built in 8.37s
  check:solid      → CSS 消费审计通过（注入 113 / 消费 350 / 声明 353，死注入与悬空引用均为 0）
                     ZONE_FIELDS 一致性契约通过（189 个主题字段，排除元字段：appliedPreset, custom, ccEditMode）
  test             → Test Files 627 passed (627) | Tests 4743 passed | 1 todo (4744)
  ```

- **⑥ 测试处置的红→绿对照**（改断言前：旧断言 + 新代码）：

  ```
  AssertionError: expected [ 'ccHeight', …(79) ] to have a length of 83 but got 81
  AssertionError: claude 键数: expected 188 to be 191
  AssertionError: claude.ccHintFontSize: expected false to be true
  AssertionError: expected undefined to be 17
  AssertionError: expected false to be true        # ZONE_FIELDS.cc.includes(ccStatusFontSize)
  AssertionError: expected { 'cc-surface': 9, … } to deeply equal { … }
  Tests 6 failed | 33 passed (39)
  ```

- **⑦ 设置页实机核验**（同一 Part A 二进制）：设置左侧分组 = 局部预设 / 基础 / 输入栏 / 发送按钮 /
  模型控件 / 思考强度控件 / 权限控件 / 外观风格 / **控件样式** / 输入与状态 / 波形与用量 / 布局编辑
  —— **无「状态信息」**；`状态信息字号`、`状态区背景`、`状态区背景图` 三串在整页 HTML 里均不存在；
  「输入与状态」行数 = **10**；「控件样式」里有「快捷提示字号」。

## 与 spec 的偏差

1. **命令行提示升格（原施工单 §2.1）本轮未做，交回翻译另写单**（施工单 §4-3 / §4-4 停手条件命中）。
   实测四条后果（探针 jsdom 真挂载，非推断）：
   - 只翻 `draggable: true`（不加渲染分支）⇒ 提示**不是"消失于无分支"，而是先被 `passesStatusGate` 滤掉**
     （`ControlCenter.solid.tsx:294`）—— 施工单对头号坑的成因判断与代码现实不符；
   - 补分支 + 常态放行后：cli 信息栏分隔点 **3 → 4**（多一个 `·`）；
   - **非 cli 模式的活跃会话**：提示体渲染为 null，但它仍在组名单里 ⇒ 出现**尾随孤立 `·`**；
   - `cli + peri` 最小高度 **84 → 109px（+25px）**（`visibleStatusWidgets` 4 → 5 越过换行阈值，
     该项同时喂 `--cc-min-height` 与 `clampCcHeight`）。
   ⇒ 要真正做到「可见行为零变化」，还需：可见性谓词化、计数排除、分隔点排除、CSS 适配 —— 已超出「翻一个布尔」。
2. **新增 `ccHintFontSize` 导致出厂数据要"补键"（施工单只写了"删键"）**：`terminalPresets.test.ts`
   要求每套终端预设覆盖全部主题字段 ⇒ 必须补进 6 套完整快照型条目。翻译 §6.2 已裁定走此路（否决「非主题字段」）。
3. **peri 提示字号 +0.86px（已裁定接受）**：根因是 `.cc-footer-status-row` 是**死类名**
   （渲染方用的是 `.cc-footer-status`，它**没有** font-size）⇒ 改造前 peri 下提示的 `0.86em` 相对
   `.cc-body` 的 **15px** 折算（= 12.9px，本机 `--global-font-size` 15px），而 free 下相对 16px（= 13.76px）。
   统一成 `calc(var(--cc-hint-font-size,16px) * 0.86)` 后两模式都是 13.76px。
   ★ 施工单 §0-2 写的「现值 16px」只对 free 成立。翻译裁定：接受（把提示字号统一到一个值正是"元件自己管字号"的目的）。
4. **顺手删掉 `GROUP_ORDER` 里空掉的「状态信息」组登记**：不删的话设置页左侧导航会留一个点了没内容的入口
   （`SettingsSheetSidebar.tsx` 从 `GROUP_ORDER` 派生二级项）。已获翻译裁定接受（§6.3-2）。
5. **`chat/StatusBar.css` 的 `var(--status-bg,…)` / `var(--status-bg-image,…)` 未清**：按施工单属第③件死数据清理；
   两个引用都带 fallback，门禁不红。已登记第③件（§6.3-3）。

## 未解问题

1. **刀5B（命令行提示升格）要先补两条表语义**（翻译在施工单 §6 排期里已写）：
   ①「可见性由模式决定」（而非只由 `ccHidden` 决定）；②「整行元件 vs 行内元件」（决定分隔点与行计数怎么算）。
   四条实测后果可直接当验收靶子。
2. **`--cc-hint-font-size` 目前只有命令行提示一个消费者**：将来若还有其他"提示类"小字，应复用而不是各加一个字段。
3. 用户在编辑态拖过、且老数据停在旧位置的元件，仍按刀4 的口径**不消解存量重叠**（等一次「强制重置到默认」）。

## 并行交集

本次碰过的共享文件（供其他贡献者避让）：

- 中控区：`src/themeFieldDefs.ts`、`src/store.ts`（`ThemeSettings` 接口）、`src/domains/cc/widgetDefinitions.ts`、
  `ControlCenter.css`（`builtin.pylon-renderers` 首方样式）。
- 主题域：`src/domains/theme/themeCssSnapshot.ts`、`src/domains/workbench/workbenchSkinContract.ts`、
  `__fixtures__/workbench-skin-baseline.json`（快照只能脚本重拍）。
- **预设组装线**（该线已合入 main、无并行写者）：`src/zones/factory/{terminal-cc,gui-cc}.ts`、
  `src/__tests__/effectivePresetTheme.test.ts`、`src/__tests__/presets.test.ts`。
- 测试：`src/domains/cc/__tests__/widgetDefinitionTable.test.ts`。
- 仓外一次性工具（不入库）：`.agents/spec/238-刀5-probe-surface-panel.mts`、`.agents/spec/238-刀5-probe-preset-counts.mts`。
