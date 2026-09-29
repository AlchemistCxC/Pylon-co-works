# Dev Record — #266 刀 3 最小高按边算取最大（显隐与布局两层模型 · 精确版）

> 入库保留。施工单不保留，其目标、范围、方案与验收结论在此承接。
> **验收读数与红段全文另存仓外**：`E:\Acode\FILES\任务\工作台优化\报告等\06-施工单-最小高按边算取最大（刀3）\2026-09-28-工作者汇报.md`。

## 元信息

- issue：[#266](https://github.com/AlchemistCxC/Pylon-co-works/issues/266)（显隐与布局的两层模型 · **刀 3**）
- 分支：`feat/cc-visibility-two-layer.2`（接刀 2 存档点 `35c41546` 继续；**未新建分支**）
- 提交范围：**未提交**（施工单要求不 commit / 不 push / 不开 PR）
- 日期：2026-09-28
- 依据：施工单 `待办\06-施工单-最小高按边算取最大（刀3）.md`；规范 §六 / §七 / §7.9 / §八
- **前置**：刀 1（#426）已在 main；刀 2.5（#431）—— 见"并行交集"（fetch 失败，用本地分支并入，未提交）

## 目标与范围

**目标**：中控区最小高从**常量 64** 换成**按边算取最大**：
`min_height = max(BASE_MIN_HEIGHT(64), inputOffsetTop + 输入栏组高, ccMarginBottom + 下边组高)`，组 = 竖向落脚处，两组取 **max**（输入栏绝对定位、不占流），下边组行数恒 1（刀 2.5 前提）⇒ 无折行档。

**不做**：横向（折行 / 重叠 / 宽度 / 位置声明 —— 刀 2.5）；③ 显示前校验（刀 4）；多行增高（CSS 已把 `--cc-input-extra-height` 加在容器高上，不进最小高）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/cc/ccHeightState.ts` | `ROW_MIN_HEIGHT(28)` + `VERTICAL_EDGE_FIELD` + `CcMinHeightGroup` / `CcMinHeightInput` / `CcMinHeightScalarKey` / `ccMinHeightInputOf` / `resolveCcHeightGroups` / `resolveCcMinHeight`（算式）/ `clampCcHeight(height, input)`；替换刀 9~11 的"常量"注释段 | 修改 |
| `src/domains/cc/widgetDefinitions.ts` | 行声明 `heightField`（件高来源；缺省 = 内容撑）+ 四行填值（input/model/reasoning/mode） | 修改 |
| `src/themeFieldDefs.ts` | `ccHeight.minFn` 改回按在场算 | 修改 |
| `src/domains/workbench/workbenchAppearanceStore.ts` | 两处 clamp 传算式输入；删掉重复的"输入栏抬高"规则 | 修改 |
| `src/domains/theme/presetReducer.ts` | `clampPresetCcHeight` 补 `DEFAULTS` 标量；cc 分支传合并视图；3 处 `syncPresetCcHeight` 传装配后有效值 | 修改 |
| `src/store.ts` | `setCcHeight` / `setCcHidden` 两处 clamp 传算式输入（后者用**新**名单） | 修改 |
| `src/domains/theme/migration.ts` | 读盘路径 clamp 传算式输入 | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | `minHeight()` 改算式值挂 `--cc-min-height` | 修改 |
| `src/domains/cc/__tests__/ccHeightState.test.ts` | "最小高度"整组按新算式重写（8 → 12 条） | 修改 |
| `src/domains/theme/__tests__/presetReducerPureHelpers.test.ts` | 下界用例改为锁算式 | 修改 |
| `src/domains/theme/__tests__/presetReducer.test.ts` | 补"下界来自算式"一条 | 修改 |
| `src/domains/workbench/__tests__/appearance.test.ts` | 补"显隐一变最小高跟着变"一条 | 修改 |
| `src/domains/workbench/__tests__/zustandWorkbenchAppearanceStore.test.ts` | **新增**：生产通路（zustand）3 条（退改②） | 新增 |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 补 `heightField` 归属守卫一条 | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 契约快照重拍（`--write`） | 修改 |

## 方案要点

1. **组 = 竖向落脚处**（`y.anchor:y.side`，与渲染成组同源）。组高 = 组内**在场**件高的最大；件高按定义表 `heightField` 声明取，**内容撑件按 0**（结果是下界，与最小宽同性质）；悬浮件不参与。
2. **行高兜底 `ROW_MIN_HEIGHT = 28`**（整行都算不出高时）。★ 事实核对：规范 §7.2 的"≥18px"出自 `ControlCenter.css:118`，但同文件 `:322` 的 `min-height: var(--ui-control-compact)`（`src/index.css:66` = 28px）覆盖它 ⇒ 取 28（既 ≥18 又与渲染真值一致），出处写在常量注释里。
3. **两组取 max 不是 sum**：输入栏 `position:absolute` 不占流（`ControlCenter.css:89-96`）。
4. ★★ **在场集合口径 = 两态取 max**（用户 2026-09-29 退改定）：`min_height = max(BASE_MIN_HEIGHT, 算式(常态切面), 算式(空态切面))` —— 同一算式跑两遍、喂两份切面、取 max。理由：空态切面是自由的（刀 2 的产物），某套预设的空态**可以比常态在场更多** ⇒ 只按常态算会低估空态、显示时可能超界；取两态 max 才真的"两态都成立"，且仍是"预设值 + 一道门"两层、**不引入新概念**。空态切面缺省 ⇒ 回落常态切面（与刀 2 落值口径 `inheritCcEmptySlice` 同义）。四个调用面经唯一拼装点 `ccMinHeightInputOf` 自动统一。
5. **算法不认元件 id**：高度来源由**表声明**（`heightField`），算式只读声明 ⇒ 加件 / 换字段只改表。
6. **零行为变化**：默认口径 = `max(64, 50, 43)` = 64 = 改造前常量 ⇒ 出厂观感不变（`presetAssembly` 的 claude 76 等既有断言原样通过）。
7. **未改**：`ControlCenter.css`（一个字）、`resolveCcMinWidth` 一族、`ccLayout`、`detachX`、显隐谓词与刀 2 的两层模型。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 算式已落地（`BASE_MIN_HEIGHT` 作下界） | ✅ `resolveCcMinHeight` 的 reduce 初值即 `BASE_MIN_HEIGHT` |
| 调用面同步（`minFn` / store / presetReducer） | ✅ 六处调用面全传算式输入；`minFn` 不再是常量转发 |
| ★ 实机三态逐条 预测 vs 实测；藏显一件变化 | ✅ **85 / 64 / 68 / 130** 四组逐条命中 `--cc-min-height`；藏显一件 = **85 ⇄ 64**。★ 退改后重跑：**85 / 64 / 85 / 130**，其中"常态藏得多、空态藏得少"那组取**空态**的 85（旧口径会得 64 ⇒ 低估） |
| 不变量（下界 ≤ 值 ≤ 400；NaN 回落下界） | ✅ 新增用例逐条夹（6 口径 × 9 取值） |
| 横向未动 | ✅ 本刀 diff 无 `ControlCenter.css` / `ccLayout` / `detachX` 行 |
| 门禁五步 + 快照重拍 | ✅ 六步 exit 0；`Test Files 663 passed | 1 skipped`、`Tests 5145 passed`（基线 5138 ⇒ +7） |

## 测试处置

- **主改** `src/domains/cc/__tests__/ccHeightState.test.ts`：原两条锁"常量 64"的用例按算式重写为 6 条（组结构与默认口径 / 行兜底 / 在场集合变化 / 悬浮件 / clamp 上下界与 NaN / 不变量）。
- **改口径** `presetReducerPureHelpers.test.ts`（下界=算式，另补抬高两例）、`presetReducer.test.ts`（补"下界来自算式"一条，原 D1 断言保留）。
- **补** `appearance.test.ts`（store 级"显隐一变最小高跟着变"：64 ⇄ 75）、`widgetDefinitionTable.test.ts`（`heightField` 必须由本行成员拥有；★ 第一版判据写成"在属性面板里"被自己的守卫抓红，改为"成员拥有"）、**`zustandWorkbenchAppearanceStore.test.ts`（新增，生产通路 3 条，退改②）**。
- **未改仍绿**：`presetAssembly.test.ts`（claude 76 / `0 ⇒ 64` 与新算式相符）、`mountSolidWorkbench`、`workbenchChromeCss`、刀 2.5 的宽度族用例。
- **快照重拍**：`workbench-skin-baseline.json`。

## 证据

- commit：**无**（未提交；施工单要求）
- 测试：`bun run test` → `Test Files 663 passed | 1 skipped (664)`、`Tests 5145 passed | 1 skipped | 1 todo (5147)`、EXIT 0（改动前同树基线 5138）
- 门禁：`lint` / `build:example-plugin` / `build` / `check:solid` / `test` / 契约快照 `--write` 全 exit 0
- 反向验证：**4 轮**（max→sum 9 红；忽略在场集合 3 红；下界退回常量 3 红；clamp 用旧名单 1 红），红段全文在仓外报告 §5
- 实机：`bun run build` → `cargo build`（51.5s）→ `src-tauri/target/debug/pylon.exe`（WebView2 `Edg/153.0.4234.48`）；四组读数见仓外报告 §4；验收后已关 App、9222 无监听者、后端日志无 error、主题数据逐字节还原（备份另存 `E:\Acode\FILES\_backup\pylon-data-20260928-cc-visibility-2\`）
- ★ 反向验证 ④ 第一次打错位置（打在 zustand 的 `setCcHidden` ⇒ 没红），查明真链路（`workbenchAppearanceStore.reduceAppearanceCommand`）后重打才红 —— 过程与结论都记在报告 §5

## 与 spec 的偏差

1. **行高兜底取 28 而非规范 §7.2 写的 18**：18 来自被覆盖的旧规则（`:118`），现行 `.cc-status-row` 实际是 `--ui-control-compact: 28px`（`:322`）。判据与出处写进常量注释，取 28 同时满足"≥18"且与渲染真值一致。
2. **在场集合口径取常态切面**（规范 §七只说了"行高 = 该行在场件的最大高"，没说哪一份切面）：见"方案要点 4"，含已知边界。
3. **刀 2.5 以"本地分支 squash 并入"落地**（未从 main 合并）：见"并行交集"，联网后请核一次。
4. **多碰 4 个文件**：`store.ts` / `migration.ts`（`clampCcHeight` 签名的直接依赖，缺一处即编译不过）、`__tests__/widgetDefinitionTable.test.ts`（新增 `heightField` 声明的归属守卫）、`__tests__/presetReducer.test.ts`（施工单 §五点名"改锁算式"）。
5. `appearance.ts` 那条"把 ccHeight 抬到容得下输入栏"的规则**被删**（算式已含该项，同一规则不再维护两遍）。

## 未解问题

1. ~~zustand 通路无单测直达~~ **已补（2026-09-29 退改②）**：新增 `src/domains/workbench/__tests__/zustandWorkbenchAppearanceStore.test.ts`（3 条，走真实 `useStore` 动作 + 回推快照）；反向验证把 break 打在 `store.setCcHidden` 上 ⇒ 新用例红、静态那套仍绿（证明缝补上了）。
2. **刀 2.5 与 main 的等价性无法离线核对**（`b5768d76` 不在本地、fetch 失败）。
3. 空态/常态哪一份"在场更多"是**预设数据**决定的（出厂数据里空态是超集 ⇒ 两态 max = 常态值，观感不变）；若将来有预设让空态在场更多，下界会自动跟着空态那一份走（退改①已解决，不再留边界）。

## 退改（2026-09-29 · 用户验收反馈两条）

| # | 退改 | 落点 | 证据 |
| --- | --- | --- | --- |
| ① | 在场集合从"只算常态切面"改成**两态取 max** | `ccHeightState.ts`：`CcMinHeightInput.hiddenIds` → `hiddenSlices`；`ccMinHeightInputOf` 拼 `[常态, 空态（缺省⇒回落常态）]`；`resolveCcMinHeight` = 逐态算一遍取 max；新增 `sliceHeightRequirement`；`resolveCcHeightGroups` 签名改 `(hiddenIds, scalars)`（单态，与最小宽同形）。**其余 6 个调用面代码零改动**（都经 `ccMinHeightInputOf` 取输入） | 实机 ★C 组：常态藏 3 件、空态只藏 send-button ⇒ 下界由**空态**那份的 **85** 决定（旧口径 64）；反向验证⑤红 2 条 |
| ② | 补**生产通路**（zustand）用例 | 新增 `src/domains/workbench/__tests__/zustandWorkbenchAppearanceStore.test.ts`（3 条：改显隐 ⇒ 最小高跟着变 / `set-cc-height` 走算式下界 / 两态取 max） | 反向验证⑥：break 打在 `store.setCcHidden` ⇒ **新用例红、静态套件仍绿**（旧覆盖抓不到） |

- 门禁六步 + 快照重跑：`Test Files 664 passed | 1 skipped (665)`、`Tests 5150 passed`，全 exit 0。
- 出厂 10 套两态切面同值（空态是常态的超集）⇒ 改口径**不产生观感变化**（默认口径仍 64、出厂数据仍 85）。
- 退改报告：`E:\Acode\FILES\任务\工作台优化\报告等\06-施工单-最小高按边算取最大（刀3）\2026-09-29-退改汇报（两态取max+生产通路用例）.md`。

## 并行交集

- **刀 2.5（#431）已并入本分支工作树（未提交）**：8 个文件（`ccHeightState.ts` / `widgetDefinitions.ts` / `ControlCenter.solid.tsx` / `ControlCenter.css` / 两个 cc 测试 / 两个 renderer 测试）。**三个文件被刀 2 与刀 2.5 同时改过**，现已在工作树里合成一版（文件头注释那一处冲突按"双方保留"解）。
- 行号/结构提醒：本刀之后 `ccHeightState.ts` 里"最小高"族在上、"最小宽"族（刀 2.5）在下，两族同构；`widgetDefinitions.ts` 的行上现在有 `heightField`（刀 3）与 `detachX`（刀 2.5）两个可选声明位。
- **提交/存档注意**：HEAD 仍是 `35c41546`（刀 2 存档点），工作树 = 刀 2.5 + 刀 3；按 pathspec 提交时请把这两批一起处理，别只带刀 3（否则刀 2.5 的内容会以"未提交改动"留在树上）。
