# Dev Record — #238 刀7 删掉「缩放」（`ccScale` 整套）

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\元件定义表\10-施工单-刀7-删掉缩放.md`
> 规范：同目录 `00-施工规范-中控元件定义表-v1.0.md` §7（刀7 行）；分支 `feat/cc-widget-definition-table`

## 元信息

- issue：[#238](https://github.com/AlchemistCxC/Pylon-co-works/issues/238)
- 分支：`feat/cc-widget-definition-table`（**未 push、未开 PR**，本地领先远端）
- 提交范围：`3400b2a8..73d50c03`（`3400b2a8` L.md 声明 → `73d50c03` 实现）
- 日期：2026-09-23
- 用户口径：2026-09-23「第二个不要，大小都是调节上下左右的，**我预期里没有缩放这一项**」

## 目标与范围

删掉「缩放」（`ccScale`）**这一整套**：字段 / 默认值 / store 类型与动作 / 布局状态动作 /
外观快照与 `set-cc-scale` 命令 / **唯一应用点** / 编辑态面板输入框 / 夹具样本 / 预设字面量 /
出厂数据 / 9 份测试同步 / 契约快照。

**两处预期变化**（其余零变化）：
1. 编辑态属性面板**不再有「缩放」**（用户可见的项少一个）；
2. 用量（tokens）字号**不再乘缩放** ⇒ 调过缩放的人回到基准字号；没调过的人（= 100）逐项不变。

**不做**：位置与宽高字段（`modelWidth` 等）、碰撞约束（刀4）、可见性、插件契约面、
`rendererKey` / `isolated-surface`、`sendVariant`、面板分块（刀6）。

## 改动清单（32 文件）

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/themeFieldDefs.ts` | 删 `ccScale: H(...)` 字段定义；`default` 注释去掉 ccScale | 修改 |
| `src/domains/theme/themeDefaults.ts` | 删 `ccScale: {}`；头注释同步 | 修改 |
| `src/store.ts` | `ThemeSettings.ccScale` 类型字段；`setCcScale` 动作与接口声明；不再用的 `setCcScaleState` import；两条过期注释 | 修改 |
| `src/ccLayoutState.ts` | 删 `setCcScaleState` | 修改 |
| `src/domains/cc/widgetDefinitions.ts` | `CC_SYSTEM_FIELDS` 3 → 2；表头/`draggable`/系统桶三处注释「三份名单」→「两份」 | 修改 |
| `src/domains/workbench/appearance.ts` | 快照字段 `ccScale`、`freezeAppearanceSnapshot` 一行、`AppearanceCommand` 的 `set-cc-scale` 变体 | 修改 |
| `src/domains/workbench/workbenchAppearanceStore.ts` | `set-cc-scale` 命令分支 + import | 修改 |
| `src/domains/workbench/zustandWorkbenchAppearanceStore.ts` | `set-cc-scale` 的 action 调用分支（★ 清单外，见「偏差」2） | 修改 |
| ★ `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | **唯一应用点**：用量字号 `calc(modelFontSize * ccScale.tokens / 100)` → `modelFontSize`；**编辑态面板「缩放」输入框整块删** | 修改 |
| `src/domains/workbench/workbenchSkinContract.ts` | 边界夹具里的 `ccScale` 两处（`edge` 生成 + 样本 125） | 修改 |
| `src/presets/builtin.ts` | `GLASS_THEME` 的 `ccScale` 字面量（tokens/model/mode = 100） | 修改 |
| ★ `src/zones/factory/*.ts` | **10 个文件**：删 **7 个 `ccScale` 数据块** + **10 处头注释**（见「出厂数据手改清单」） | 修改 |
| `src/domains/theme/migration.ts` | ★ 清单外：`renameLegacyCcScaleKeys` 与调用点退场；v11 历史注释补一句 | 修改 |
| 测试 9 份 + `mountSolidWorkbench` | 见「测试处置」 | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 脚本重拍（**不是手改**） | 修改 |

### 出厂数据手改清单（★ 施工单 §1-12 要求「列出文件名与处数」）

**真值与施工单的估计不一致**（见「与 spec 的偏差」1）。实测（`git show HEAD:<file> | grep -c "ccScale: {"` 与改后对比）：

| 文件 | 删掉的 `ccScale` 数据块 | 值 | 头注释改动 |
| --- | --- | --- | --- |
| `src/zones/factory/terminal-cc.ts` | **5** | `{tokens:90,model:90,mode:90}` ×1、`{tokens:95,…}` ×4 | 1 处 |
| `src/zones/factory/gui-cc.ts` | **2** | `{tokens:100,…}` ×1、`{tokens:95,…}` ×1 | 1 处 |
| `gui-chat.ts` / `terminal-chat.ts` / `gui-global.ts` / `terminal-global.ts` / `gui-sidebar.ts` / `terminal-sidebar.ts` / `gui-right.ts` / `terminal-right.ts` | 0（本来就没有数据块） | —— | 各 1 处 |
| **合计** | **7 处数据块**（分布在 2 个文件） | —— | **10 处注释**（含上面两个 cc 文件） |
| `src/zones/factory/index.ts` | 未触碰 | —— | —— |

★ 头注释那 10 处改的是同一句：「cc 区含 ccLayout/ccHidden/ccScale **三个**元件名单字段」→「**两个**」。

## 方案要点

1. **唯一应用点的改法**：原先 `'font-size': calc(${modelFontSize}px * ${ccScale.tokens} / 100)`。
   改回**纯基准字号** `${modelFontSize}px`（不是把乘数固定成 1）—— 这样字符串里**不再有 `calc(`**，
   一旦有人把乘数加回来，测试里的逐字断言立刻红（见「证据」⑥）。
2. **`CC_SYSTEM_FIELDS` 由 3 变 2**：`ccScale` 从来不属于任何**成员**（它是跨元件系统字段），
   所以成员计数一行不动，只有系统桶 −1；字段总数 81 → 80（cc zone）。
3. **落盘侧不写迁移键清除**（与刀5A 同处置）：`store.ts` 的 `partialize` 是
   `THEME_SETTING_KEYS` 白名单式，`ccScale` 已不在名单里 ⇒ **下一次写盘自然修剪**。
   实测证据见「证据」⑤（切一次界面模式即从 localStorage 消失）。
4. **`renameLegacyCcScaleKeys` 随之退场**（清单外，理由见「偏差」1）：它是 v11/刀4 为 `ccScale`
   写的 legacy `send` → `cc-send-button` 键改名；字段删了它就是**读一个不存在的域字段**的死代码。
5. **契约快照**：`ccScale` 是 `noCssVar: true` 的字段 ⇒ **CSS 变量集合一个没动**（96 不变），
   快照只少 `ccScale` 键与 `themeSettingCount` 减一。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步 | ✅ `lint`（0 error，唯一 warning 在他人文件 `RightRailHost.tsx`）/ `build:example-plugin` / `build` / `check:solid` / `test` 全绿 |
| 全量测试对账 | ✅ **627 文件 / 4752 通过 + 1 todo** —— 与上一刀（第③件补遗）**逐数字相同**（本刀只改既有断言、未增删用例；`mountSolidWorkbench` 内新增的 2 条断言写在既有用例里，用例数不变） |
| 契约快照重拍 + 逐条 diff | ✅ 删除 53 行 / 新增 1 行，**全部可解释**（15 份 fixture 各少一个 `ccScale` 键 + `themeSettingCount` 189→188；无其它差异） |
| CSS 消费审计 | ✅ 注入 113 / 消费 348 / 声明 353 / 死注入 0 / 悬空引用 0 —— **与改造前逐项相同**（字段无 CSS 变量） |
| ★ 实机：`ccScale.tokens=100` 时逐项相同 | ✅ 中控 6 件盒模型、组 gap、min-height、用量字号（12px）**与改造前逐位相同** |
| ★ 实机：非 100 旧数据回基准字号 | ✅ `tokens=90`：改造前 **10.8px**（= 12×0.9）→ 改造后 **12px**（= `modelFontSize`） |
| 实机：落盘不再写 `ccScale` | ✅ 触发一次写盘后 `localStorage['pylon-theme'].state` 里 **`ccScale` 键消失** |
| 实机：编辑态面板 | 🟡 **本会话打不到编辑态入口**（见「未解问题」3）：改由 ①组件级 DOM 断言 ②产物核对（`dist` 里 `控件缩放`/`set-cc-scale`/`ccScale` 命中数全 0，而 `顺序/水平微调/垂直微调` 仍在）作证 |
| 反向验证（两条） | ✅ ①「字段删了但面板输入框还在」→ 断言红 ②「面板删了但应用点还在」→ 新断言红 + `check:solid` 的 `tsc` 红（见「证据」⑥） |
| 开发记录 / 总表 / issue 回写 | ✅ 本文件 + 仓外《中控元件总表》 + #238 评论 |

## 测试处置（9 份 + 1 份新增断言；**未增删任何用例**）

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `domains/cc/__tests__/widgetDefinitionTable.test.ts` | `ccFields` 81 → **80**；`CC_SYSTEM_FIELDS` 3 → **2**；总数 81 → **80**；用例标题「三份名单」→「名单」 | 契约变更：字段与系统桶各 −1 |
| `domains/theme/__tests__/structuralAlignment.test.ts` | 样本里的 `ccScale: {model:120}` 换成 `ccBgImage: 'url(fixture.png)'`，断言同步 | 「已设字段值原样保留」的**覆盖不丢**，只换一个存活的 cc 区字段当样本 |
| `domains/theme/__tests__/themeSchemaV8Backfill.test.ts` | 用例名与断言：`ccHidden` 迁移保留；`ccScale` 由「被改名」改成「**不再被改名**（值原样穿过）」 | `renameLegacyCcScaleKeys` 已退场 |
| `domains/workbench/__tests__/appearance.test.ts` | 4 处：快照样本/`isFrozen`/命令派发/`revision` 与通知次数（3 → 2）与用例名 | 快照字段与命令删除；少一次派发 ⇒ revision 与通知次数各 −1 |
| `domains/theme/__tests__/settingsTraceability.test.ts` | hidden 字段白名单去掉 `'ccScale'` | 字段已不在表里，登记项必须同步（该测试的职责就是"hidden 清单不许悄悄变"） |
| `plugin-runtime/skin/__tests__/skinSchema.test.ts` | 删 `ccScale?.default` 那条断言 | schema 由 defs 派生，字段没了自然没有该条 |
| `renderers/.../__tests__/mountSolidWorkbench.solid.test.tsx` | 删「控件缩放」的输入与两处 `ccScale.model` 断言；**新增 2 条**：面板 `控件缩放` 必须为 `null`、用量字号逐字等于 `modelFontSize`（且不含 `calc(`） | 面板项删除 + 唯一应用点锁住 |
| `__tests__/customPresets.test.ts` | 白名单样本由 `ccScale` 换成 `ccBgImage`；另一处的 `ccScale` 样本**保留**但判据反转为「被白名单挡掉」 | 前者换存活字段，后者正好复用成"已删字段不得再进自定义预设"的样本 |
| `__tests__/effectivePresetTheme.test.ts` | `BASELINE_FIELD_COUNTS` 按**真值**重算：6 套 189 → **188**、`glass` 69 → **68**、3 套 agent-* 36 不变；`key === 'ccScale'` 的例外去掉 | 预设线基线随表演进 |

## 证据

- **commit**：`73d50c03`（32 文件）；`git status` 干净；**未 push、未开 PR**。
- **① 停手条件逐条核对（开工前）**：
  - 条件 1（除 tokens 外还有真实消费者）：`grep -rn "ccScale"` 的生产侧命中只有
    `ControlCenter.solid.tsx` 两行（363 字号 / 683 面板）⇒ **无第三个消费者**；
  - 条件 4（删 `set-cc-scale` 牵动清单外文件）：命令相关的生产文件 = `appearance.ts`（联合类型）、
    `workbenchAppearanceStore.ts`（分支）、`zustandWorkbenchAppearanceStore.ts`（action 调用，**清单外**，见偏差 2）；
    **未牵动插件契约面**；
  - 条件 5（缩放被用于布局/碰撞）：`ccLayoutState.ts` 里它只有 `setCcScaleState` 一个纯函数，
    `ccPlacementCollision.ts` / 布局归一化**零命中** ⇒ 是纯外观。
- **② 门禁五步**：

  ```
  lint                 → ✖ 1 problem (0 errors, 1 warning)   # 警告在 right-panel/RightRailHost.tsx（他人文件）  EXIT=0
  build:example-plugin → EXIT=0
  build                → EXIT=0
  check:solid          → EXIT=0；CSS 消费审计通过（注入 113 / 消费 348 / 声明 353，死注入与悬空引用均为 0）
  test                 → Test Files 627 passed (627) | Tests 4752 passed | 1 todo (4753)   EXIT=0
  ```
  **对账**：上一刀（第③件补遗）终点同为 **627 / 4752+1** ⇒ 本刀**只改断言、未增删用例**，数字不变（不是漏跑）。
- **③ 契约快照 diff（逐条）**：

  ```
  53 行删除 = 15 行 `"ccScale": …`（15 份 fixture 各一处：10 份带值 4 行、5 份空对象 1 行）
            + 38 行随附的值与花括号
   1 行新增 = `"themeSettingCount": 188`（原 189）
  ```
  除此之外**零差异**；快照脚本自报 `主题字段 188 个；Workbench CSS variables 96 个；fixture 15 个`
  ——**CSS 变量数不变**（`ccScale` 是 `noCssVar` 字段，不注入变量）。
- **④ 实机 · 两种情况（普通 `cargo build` 二进制 + WebView2 调试端点，A/B 两次构建）**：

  ```
  A/B 做法：先把工作树临时还原到 HEAD（本刀前）构建一次、启动、量「改造前」；
           再恢复本刀改动、重新 `bun run build` + `cargo build`、量「改造后」。同一份 localStorage。

  ① ccScale.tokens = 100（"没调过的人"）—— 改造前 vs 改造后逐项相同
     用量胶囊字体 12px  / 胶囊盒 94.59×28 @695.4,754  / 提示 205.23×18.57 @793.98,758.71
     六件盒模型：input 900x40@275,686 / model 120x28@299.4,754 / reasoning 132x28@423.4,754 /
                mode 132x28@559.4,754 / tokens 94.59x28@695.4,754 / hint 205.23x18.57@793.98,758.71
     组 gap 4px、min-height 64px、--cc-height 109px（落盘值未被抬高）
     ⇒ 改造前后**逐位相同**

  ② ccScale.tokens = 90（"调离过基准"的旧数据；★ 用户当前应用的是 claude 出厂预设，其值就是 90）
     改造前：用量字号 **10.8px**（= modelFontSize 12 × 90/100）
     改造后：用量字号 **12px**（= modelFontSize，不再是乘数）
     ⇒ 与施工单 §2-2 的描述一致（回到基准字号）；胶囊随之变宽 87.34 → 94.59，右侧提示右移 7.24px

  ③ 落盘核对：切一次「现代 GUI」触发写盘后
     localStorage['pylon-theme'].state 里 `ccScale` = **KEY_ABSENT（已被白名单修剪）**
     （切回「经典终端」复核主题值原样：inputMode cli / footerLayout free / cliHintMode compact /
       ccHintFontSize 16 / ccHeight 109 / ccHidden ['cc-send-button','attach'] / appliedPreset 全 claude）

  ④ 其它回归：分隔点 0、`.cc-status-entry` 0、中控元件 6 件（cli 下）
  ⑤ 控制台：只有一条与本刀无关的 `切换 Agent失败`（`openOwnedSessionTransaction.ts`，本环境无 Agent runtime）
  ```
  ★ **实测发现一条施工单没写到的变化**：用户的**出厂预设 `claude` 自带 `ccScale.tokens=90`**
  （不是 100）⇒ 对"用出厂预设的人"字号**会变**（10.8 → 12px）。详见「与 spec 的偏差」1。
- **⑤ 产物核对（编辑态面板项，替代打不到入口的现场点击）**：

  ```
  dist 里：控件缩放 0 / set-cc-scale 0 / ccScale 0    （运行中二进制内嵌的就是这份 dist）
  dist 里：水平微调 2 / 垂直微调 2 / 控件顺序 1        （其余面板项仍在）
  实机 DOM：`[aria-label="控件缩放"]` = 0
  ```
- **⑥ 反向验证（两条，贴红）**：

  ① **「字段删了但面板输入框还在」**（把那段面板输入框放回去、用 `any` 绕过类型）：

  ```
  FAIL  mountSolidWorkbench > 属性面板可编辑顺序、偏移和 schema 外观字段
  AssertionError: expected <input type="number" …(5)></input> to be null
    aria-label="控件缩放"
      1847|     expect(screen.queryByLabelText('控件缩放')).toBeNull()
  Test Files 1 failed (1) | Tests 1 failed | 91 passed (92)
  ```

  ② **「面板删了但应用点还在（字号仍乘缩放）」**（把 `font-size` 改回 `calc(modelFontSize * ccScale.tokens / 100)`）：

  ```
  FAIL  mountSolidWorkbench > document apply 驱动消息、活动与 diagnostics，…
  AssertionError: expected 'calc(12px)' to be '12px'

  另外（去掉 `any` 后）编译期也抓得住 —— `check:solid` 里的 tsc：
  src/renderers/solid-workbench/input/ControlCenter.solid.tsx(365,85): error TS2339:
    Property 'ccScale' does not exist on type 'WorkbenchAppearanceSnapshot'.
  SOLID TSC EXIT=2
  ```
  ★ 注意：这条编译期守卫在 **`check:solid`**（`tsc -p tsconfig.solid.json`）里，**不在 `bun run build` 的 `tsc -b` 里**
  —— 渲染器层不在主 tsconfig 的图里（`tsc -b` 单独跑对这两处是 EXIT=0）。**给后来者：改 `src/renderers/**` 的类型问题只有 `check:solid` 会红。**

  两处临时改动均已还原：`tsc -p tsconfig.solid.json` EXIT=0、`mountSolidWorkbench` 92/92 绿。

## 与 spec 的偏差

1. ★ **施工单 §0 的前提「出厂数据里全是 100」不成立**（实测）：
   - 出厂数据里只有 `gui-cc` 的 `glass` 条目是 `{tokens:100,model:100,mode:100}`；
     `terminal-cc` 的 5 套是 `{tokens:90}` ×1 + `{tokens:95}` ×4，`gui-cc` 的 `solarized` 是 `{tokens:95}`；
   - **且用户当前应用的 `claude` 出厂预设的 cc 区就是 90**（实机 `localStorage['pylon-theme'].state.ccScale`
     = `{ekg:90,pct:90,tokens:90,model:90,mode:90}`，用量字号实测 10.8px = 12×0.9）。
   ⇒ 影响面比施工单说的**大**：不是"只有手动调过的人"，**用出厂预设的人也会看到用量字号变化**
   （claude/nord/tokyo/amber/matrix 90 或 95 → 基准；只有 glass 的 100 无变化）。
   **行为上仍属施工单 §2-2 那条预期变化**（"对手动调离 100 的人回到基准字号"），
   但"谁会受影响"的判断要按实测订正。本刀**按单执行**（删除是明确的），此处如实上报。
   ⇒ 若用户不希望这几套出厂预设的用量字号变化，需另行决定是否把出厂数据里的 90/95 改成 100
   （那会改预设内容，属另一件事，本刀未动）。
2. **清单外最小补齐两处**（施工单 §1 未列，但删字段/命令必然牵动）：
   - `src/domains/workbench/zustandWorkbenchAppearanceStore.ts`：它有 `case 'set-cc-scale': state.setCcScale(...)`，
     删了命令与 action 后**不删就不通编译**（`tsc -b` 会报该 case 不可比较、`setCcScale` 不存在）；
   - `src/domains/theme/migration.ts`：`renameLegacyCcScaleKeys` + 调用点（理由见「方案要点」4）。
   ★ 停手条件 4 的原文是「删 `set-cc-scale` 牵动**除已列清单外**的文件（尤其插件契约面）⇒ 停手」。
   本刀的处理与理由：这两处是**清单内改动（删命令/删字段）的必然连带**，不是"另一个功能点被牵动"，
   且**未触碰插件契约面**；按「施工单与代码现实漂移时准许为最小改动自行探索」执行，并在此显式上报供复审推翻。
3. **施工单 §1-12 的处数估计不准**：单子写「terminal-cc 6 / gui-cc 3 / 其余 8 文件各 1 ⇒ 共 18 处
   （每处一个 `ccScale` 块）」，且 6+3+8=17≠18。实测：**7 个数据块**（terminal-cc 5 / gui-cc 2）
   + **10 处头注释**（含两个 cc 文件；那 8 个文件里只有注释、没有数据块）。逐文件处数见上文清单。
4. **`themeSchemaV8Backfill` 那条用例**：`ccScale` 不再被改名后，我把它改成断言「值**原样穿过**、不再被改名」
   而不是断言"键被清掉" —— 因为读盘路径**确实不清理**它（落盘侧才修剪），断言"被清"会是假的。
5. **`customPresets` 的 `ccScale` 样本保留**（只反转判据）：它正好变成"已删字段不得再进自定义预设"的样本，
   比换成别的字段更有价值。

## 未解问题

1. ★ **出厂预设里那 6 套的 `ccScale` 值（90/95）要不要一并改成 100？**
   现状：它们随字段删除一起消失 ⇒ 用这些预设的人用量字号回到基准（claude 10.8 → 12px）。
   若用户的意图是"这些预设本来就想把用量显示小一点"，那删除就**改变了预设的视觉**；
   若要保形，需把 `ccScale.tokens` 折算进 `modelFontSize`（但那会**改动预设内容**，属另一件事）。
   ⇒ **需要用户/翻译决定**（本刀按单删除，未自行折算）。
2. **`statusBg` 时代留下的同类问题**：刀5A 删的三个 cc 字段也没有走 `REMOVED_CC_THEME_KEYS`，
   老数据里同样靠 `partialize` 白名单修剪。本刀沿用同一处置。若将来要把"已删字段"统一进迁移清键，
   是本刀与刀5A 共同的欠账（不影响行为，只影响老 localStorage 的残留键）。
3. **编辑态面板的现场实机未做**（本会话在应用内找不到「进入布局编辑器」的入口：标题栏「界面与设置」
   → 「外观」进的是模板库，工作区 sheet 里也未出现该按钮；`ccEditMode` 是 meta 字段，
   手写 localStorage 会被忽略）⇒ 以**组件级 DOM 断言 + 产物核对**替代，并在此如实标注为**未现场目视**。
   若需现场确认，可按下条路径：应用内打开「设置」sheet → 外观分区 → 「进入布局编辑器」。
4. **`ccScale` 的 legacy 值不再被改名**：老数据里若存在 `ccScale.send`，它不会被改成 `cc-send-button`
   —— 但该字段已被整体忽略，**无行为后果**（下次写盘随键一起被修剪）。记此以免后来者误判为回归。

## 并行交集

- 中控区：`src/themeFieldDefs.ts`、`src/store.ts`、`src/ccLayoutState.ts`、`src/domains/cc/widgetDefinitions.ts`、
  `src/domains/workbench/{appearance,workbenchAppearanceStore,zustandWorkbenchAppearanceStore,workbenchSkinContract}.ts`、
  `src/domains/theme/{themeDefaults,migration}.ts`、`src/renderers/solid-workbench/input/ControlCenter.solid.tsx`、
  `src/presets/builtin.ts`。
- ★ **出厂数据 `src/zones/factory/**`**（10 文件）—— 与本仓「预设组装线」区域重叠（该线已合入 main、无并行写者）。
- 快照：`__fixtures__/workbench-skin-baseline.json`（**只能脚本重拍**）。
- 测试：`widgetDefinitionTable` / `structuralAlignment` / `themeSchemaV8Backfill` / `appearance` /
  `settingsTraceability` / `skinSchema` / `mountSolidWorkbench.solid` / `customPresets` / `effectivePresetTheme`。
- ★ 与第③件/补遗的冲突面（`widgetDefinitionTable.test.ts` 与出厂数据）**已随本刀收口**：本刀是这条分支上该面的最后一刀。
- 仓外文档已同步：《中控元件总表》。
