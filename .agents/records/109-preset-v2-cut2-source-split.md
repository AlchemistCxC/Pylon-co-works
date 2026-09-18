# Dev Record — #109 预设系统 V2 · 刀2 源码拆分（`presets.ts` → `presets/` + `zones/`）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/109-preset-v2-cut2-source-split.md`

## 元信息

- issue：[#109](https://github.com/AlchemistCxC/Pylon-co-works/issues/109)（施工单 `02-施工单-刀2-源码拆分.md` 在用户工作区，不入库）
- 分支：`feat/preset-v2`
- 提交范围：基线 `7e97035f`（刀0 `a8b954db` + 刀1 `a5e92b48` + 远端 main 已并入）
- 日期：2026-09-17
- 署名：**Popper**（翻译会话 = 开工前核查 + 独立验收 + 记录）｜施工：工作者会话（`/role:worker`）
- 前置：刀0、刀1 均已完工并提交；远端 main 已合并（35 提交，零撞车）

## 目标与范围

**要达成什么**——把 876 行的单文件 `src/presets.ts` 按层拆成 `src/presets/`（预设层：类型 / 终端补全 / 内置数据 + 门面）与 `src/zones/`（区域层：`pickZoneFields` + 门面），并把 14 个消费方的 import 改到新位置。**纯搬家**：零逻辑改动、零重命名、零数据改动，唯一允许改的是 import 路径。

**不做什么**——不抽纯函数（刀0 已做）；不改 10 个预设数据；不在 `zones/` 转发 `ZONE_FIELDS`（真身在 `themeFieldDefs.ts:360`）；不建 `zones/zonePreset.ts`（刀6 的活）；不搬测试文件位置；不做 delta 转换；不 commit / push / PR。

## 改动清单

| 动作 | 文件 |
| --- | --- |
| 新增 6 | `src/presets/types.ts`（旧 `:21-41`）· `completion.ts`（旧 `:43-148`）· `builtin.ts`（旧 `:150-865`）· `index.ts` · `src/zones/pickZoneFields.ts`（旧 `:867-876`）· `zones/index.ts` |
| 删除 1 | `src/presets.ts` —— 整个删掉，**不留转发 shim** |
| 修改 14 | `applyGlobalPreset.ts` · `Settings.tsx` · `TemplateLibrary.tsx` · `workbenchSkinContract.ts` · `presets.test.ts` · `workbenchSkinContract.test.ts` · `appearance.test.ts` · `templateThemeVars.test.ts` · `migration.test.ts` · `presetReducer.test.ts` · `terminalPresets.test.ts` · `titlebarTheme.test.ts` · `completeTerminalPreset.test.ts` · `scripts/check-theme-field-consistency.mts` |

**import 拆账：14 条旧 → 18 条新**（`Settings.tsx` 1→2、`presets.test.ts` 1→3、`presetReducer.test.ts` 1→2，其余 11 个 1→1）。

## 方案要点

- **分层与单向依赖**：`builtin.ts → completion.ts → types.ts`；`zones/pickZoneFields.ts → themeFieldDefs.ts / store.ts`。两个 `index.ts` 只做门面转发。
- **`ZONE_FIELDS` 不转发**（本刀最重要的设计判断）：预设层原来那行 `export { ZONE_FIELDS }` 是"真身之外的纯转发"＝假组件，本刀把它消灭；三个原本从这里取 `ZONE_FIELDS` 的消费方（`presets.test.ts` / `presetReducer.test.ts` / `check-theme-field-consistency.mts`）改为直连 `themeFieldDefs.ts`。**这让新层对外符号从 6 个变成 5 个 —— 是有意的 API 收缩，不是搬家事故。**
- **导入写法统一带扩展名**（`'/presets/index.ts'`），与本仓既有风格一致，不依赖"目录 index 解析"这一假设。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `build:example-plugin` | ✅ EXIT=0 |
| `build`（`tsc -b && vite build`） | ✅ EXIT=0（9.17s） |
| `check:solid` | ✅ EXIT=0 |
| `test` | ✅ EXIT=0，**582 files / 3913 passed / 0 failed = 与基线同数同结果**（纯搬家的核心判据） |
| `ls src/presets.ts` | ✅ No such file |
| `rg "from '.*presets[.]ts'" src scripts` | ✅ 0 命中（含动态导入变体） |
| **字节级保真** | ✅ `builtin.ts` 的 713 行预设数据与 `git show HEAD:src/presets.ts` 的 `:150-865` **IDENTICAL**；`types.ts` / `completion.ts` / `pickZoneFields.ts` 的正文**与注释**原样保留 |
| **只改 import 行** | ✅ 14 个文件 diff 合计 **32 个改动行，非 import 行 = 0** |
| 导出面 | ✅ 5 个（`PresetName` / `GlobalPreset` / `GLOBAL_PRESETS` / `pickZoneFields` / `completeTerminalPreset`），不含 `ZONE_FIELDS`（见"与 spec 的偏差"1） |
| 10 个预设名 | ✅ 全齐，与施工单 §3.1 名单逐个对上 |
| 新目录边界用法 | ✅ `rg "invoke|useStore|CustomEvent" src/presets src/zones` → 0 命中 |
| 范围 | ✅ 14 改 + 1 删 + 2 新目录；三条 `??`（`docs/前端接口地图.md`、`src/layout-sketch/`、`src/ui-demo/`）为开工前既有的禁区，一行未碰 |
| 翻译独立核验 | ✅ 全部门禁自跑 + 字节保真自验 + "只改 import 行"自查 + 导出面自查 |

## 测试处置

**未修改、未删除任何行为测试。** 14 个被改文件里 9 个是测试文件，其改动**只有 import 行**（上表已证）。**本刀未新增测试**，故"新测试反向验证"不适用。全量数字与基线一致（582 / 3913）。

## 与 spec 的偏差

1. **§八-8 与 §六-1/§九 互斥**（导出面要不要含 `ZONE_FIELDS`）。裁决（翻译，2026-09-17）：**以 §六-1 / §九 为准** —— 不转发，消费者直连 `themeFieldDefs.ts`；§八-8 已按最终形态改写为"5 个符号、不含 `ZONE_FIELDS`"。工作者按此实施，正确。
2. **开工前核查订正 3 处**（翻译）：① 补入漏记的消费方 `src/__tests__/completeTerminalPreset.test.ts:3`（刀0 新增，施工单写于刀0 之前故漏）② 删掉不存在的脚本 `scripts/convert-presets-to-delta.mts`（上游 `7b348d78` / #107 当"零引用孤儿脚本"删除，2026-09-16）及其 4 处引用 ③ 数字订正：写死 `.ts` 的是 **12 处**（不是 10），`check-theme-field-consistency.mts` 属**带**后缀那一类。
3. **"16 条 import" 是翻译写错的**：实际 **14 条 → 18 条**（工作者实测提出，翻译确认并改进单子）。

## 未解问题

1. **`src/__tests__/presets.test.ts:2` 注释已过时**（写着"只迁 presets.ts 相关纯函数断言"）—— 它是**注释不是 import**，按 §九「只改 import 行」正确处理为**保留**；随**刀6 测试搬迁**时一并订正。
2. **`check:solid` 会跳过未跟踪文件（本轮 23 个，含本刀 6 个新文件）** → 新目录仅被 `tsc -b` 覆盖。已用 `rg` 补偿验证（0 命中）；**提交后再跑一次 `check:solid` 才是权威结果**（届时新文件进入扫描面）。

## 并行交集

- 新增/删除/改动共 **21 个文件**（6 新 + 1 删 + 14 改），全部在本刀文件域内。
- 触碰脚本 `scripts/check-theme-field-consistency.mts`（挂在 `check:solid` 里）—— 只改 import 行。
- 下游提示：**刀4（名单换代）的"刀2 未落地"锁已解除**；刀5/6 将按层消费 `presets/` 与 `zones/` 的新结构（`pickZoneFields` 已在 `zones/`，区域池的扩展点就在这里）。
