# Dev Record — #109 预设系统 V2 · 刀0 抽纯函数

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/109-preset-v2-cut0-pure-functions.md`

## 元信息

- issue：[#109](https://github.com/AlchemistCxC/Pylon-co-works/issues/109)（施工单 `00-施工单-刀0-抽纯函数.md` 在用户工作区，不入库）
- 分支：`feat/preset-v2`
- 提交范围：基线 `0579951d`；**本刀产物未提交**，等验收通过后由用户决定（施工单 §一-6）
- 日期：2026-09-17

## 目标与范围

**要达成什么**——把预设 / 主题 / 中控这条线上该抽的纯函数抽干净：**1 个不纯的拆成「纯计算 + 薄壳」**，**6 个已纯但私有的拎出来 `export` 并补直接单测**。铁律是**行为零变化**。

动机：这 7 个函数此前只能靠「整模块跑一遍」间接验证，改坏了要很久以后才在别处炸。抽出来之后能直接喂数据、直接验证，后续刀2（源码拆分）/ 刀4（名单换代）/ 刀5、刀6（分家、区域池）改它们时有测试兜着。规范依据是 v1.1 §7「纯函数边界」与 `.agents/dev-standards.md:11`「避免把整个 store、controller 或可变全局对象传入纯函数」。

**不做什么**（施工单 §八）——不改任何函数行为；不搬 B 类 6 个函数的位置；不改 `src/presets.ts` 的 10 个预设数据；不动 `src/store.ts`；不动 `src/domains/theme/settingProvenance.ts`（故意不纯的调试记录器）；不改任何既有测试文件；不动 `src/ui-demo/`、`src/layout-sketch/`、`docs/前端接口地图.md`；不 commit、不 push、不开 PR。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/application/transactions/applyGlobalPreset.ts` | 整流重写：新增 `GlobalPresetPlan` / `planGlobalPreset`（纯计算），`applyGlobalPreset` 退化为薄壳 | 修改 |
| `src/domains/workbench/appearance.ts` | `selectCcProperties` 定义行加 `export`（B1） | 修改 |
| `src/domains/theme/migration.ts` | `normalizeZoneRecord` 定义行加 `export`（B2） | 修改 |
| `src/domains/theme/presetReducer.ts` | `filterPresetTheme` / `clampPresetCcHeight` / `syncPresetCcHeight` 定义行加 `export`（B3/B4/B5） | 修改 |
| `src/presets.ts` | `completeTerminalPreset` 定义行加 `export`（B6） | 修改 |
| `src/domains/workbench/__tests__/selectCcProperties.test.ts` | B1 直接单测（T1，5 条） | 新增 |
| `src/domains/theme/__tests__/normalizeZoneRecord.test.ts` | B2 直接单测（T2，3 条） | 新增 |
| `src/domains/theme/__tests__/presetReducerPureHelpers.test.ts` | B3/B4/B5 直接单测（T3，8 条） | 新增 |
| `src/__tests__/completeTerminalPreset.test.ts` | B6 直接单测（T4，3 条） | 新增 |
| `.agents/L.md` | 并行施工域声明（AGENTS §2.3.5） | 修改 |

## 方案要点

**A 类（`applyGlobalPreset` 拆分）**——按施工单 §四 阶段一执行，签名与单子建议一致：

- 新增导出纯函数 `planGlobalPreset(name, lookupProfile)`，返回 `GlobalPresetPlan = { kind: 'skip' } | { kind: 'apply', presetName, theme, activateProfileId? }`。
- **呈现方案注册表由调用方查好、以纯查询函数传入**——查不到即 `skip`，这正是「预设挂着 profile 但 profile 未注册」的既有语义。把全局单例从函数体里赶出去，就是 `.agents/dev-standards.md:11` 那句话要的；传一个纯查询函数进去 ≠ 传 controller 进去。
- `ResolvedProfile` 类型从真实来源推导（`NonNullable<ReturnType<PresentationProfileRegistry['resolve']>>['value']`），theme 用 `setGlobalPreset` 第二参数的真实类型 `Partial<ThemeSettings>`；**全文件零 `any`、零 `as unknown as`**，也无需任何类型断言（`tsc -b` 直接过）。
- **副作用留在薄壳**：`activatePresentationProfile` 只由薄壳调用；薄壳统一职责是「取全局单例 → 算计划 → 按计划激活 → 按计划写主题」。

**B 类（6 个函数）**——原地加 `export`，不搬位置、不改函数体。理由是它们已经纯，搬位置不改变纯度，而刀2（拆 `presets.ts`）与刀6（区域池）会按层重新安放它们，刀0 先搬等于搬两次；刀0 的价值是「从只能间接验证 → 能直接验证」，加 `export` 就够。

**新测试的设计取向**——按施工单，重点不是覆盖率而是**钉住当前行为**，尤其两条以前没有直接测试的防线：`normalizeZoneRecord` 会**静默丢弃**区域轴外的键（刀4 名单换代时最容易踩），`completeTerminalPreset` 的 `structuredClone` 是**防止预设之间共享引用**的防线。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 基线 `git rev-parse HEAD` | ✅ `0579951d59765fe239920ae96d00574031d63fe2` |
| 基线 `bun run test` | ✅ **572 files / 3816 passed / 0 failed**（79.78s） |
| 开工前工作区 | ✅ 仅 3 项未跟踪（`docs/前端接口地图.md`、`src/layout-sketch/`、`src/ui-demo/`），与施工单预期一致 |
| §六 第 1 步：6 函数位置 | ✅ 6 命中，行号与 §3.4 表逐一一致 |
| §六 第 2 步：反向扫描 | ✅ 生产代码仅 2 处且都在单内（`settingProvenance.ts:42` 已由 §3.5 排除、`applyGlobalPreset.ts:21` 正是 A 类目标）；**无第 8 个候选** |
| `planGlobalPreset` / `GlobalPresetPlan` 导出 | ✅ 2 命中 |
| `planGlobalPreset` 体内不含 `useStore` / `getPresentationProfileRegistry` | ✅ 0 命中 |
| `any` / `as unknown as` | ✅ 0 命中 |
| 既有 `applyGlobalPreset.test.ts`（行为零变化主证据） | ✅ 1 passed / 1 |
| 6 个 `export` 命中且行号不变 | ✅ `presets.ts:131`、`appearance.ts:288`、`presetReducer.ts:40/78/99`、`migration.ts:61` |
| 4 个新测试文件逐个单跑 | ✅ 5 / 3 / 8 / 3 条全绿 |
| 反向验证 | ✅ 见下 |
| 门禁 1 `bun run build:example-plugin` | ✅ EXIT=0 |
| 门禁 2 `bun run build`（`tsc -b && vite build`） | ✅ EXIT=0，built in 13.28s |
| 门禁 3 `bun run check:solid` | ✅ EXIT=0 |
| 门禁 4 `bun run test` | ✅ **EXIT=0，576 files / 3835 passed / 0 failed**（75.33s） |
| 范围 | ✅ 5 个文件改动 + 4 个新增；基线 3 项未跟踪**未被触碰**（mtime 仍为 2026-08-11 / 2026-08-18） |
| 行为变化 | ✅ **0** —— 既有 3816 条用例全部继续通过，files 增加 4（576 = 572 + 4），tests 增加 19（3835 = 3816 + 19） |

**反向验证（证明测试真的在测，不接受只贴绿）**——挑施工单点名「最有价值的两条」各验一次：

1. **T4 深拷贝**：把 `completeTerminalPreset` 的 `structuredClone(...)` 临时降级为直传 `preset.theme.ccLayout ?? DEFAULT_CC_LAYOUT` → 只有「ccLayout 是深拷贝」那一条变红（`AssertionError: expected {...} not to be {...}` @ `:46`），另 2 条仍绿 → 精确指向深拷贝；还原后 3/3 复绿。
2. **T2 区域轴裁剪**：把 `normalizeZoneRecord` 的实现临时降级为 `{ ...defaults, ...candidate }`（保留轴外键）→ 2 条变红，其中键集合那条报出 `['cc','ccLayout','chat',…]`（`ccLayout` 泄漏）→ 精确指向「轴外键必须丢弃」；还原后 3/3 复绿。

两处降级均已完整还原，`git diff` 复核确认只剩 `export` 那几行。

## 测试处置

**未修改、未删除任何既有测试**（施工单明确禁止）。新增 4 个测试文件、共 19 条用例：

- `selectCcProperties.test.ts`（T1，5 条）：① 只挑中控可编辑键、不多不少（43 个键逐个列出并整体比对）② 取值逐一取自同名字段 ③ 空输入 → 键集合不变、取值全 `undefined` ④ 缺字段输入 ⑤ 不修改入参（冻结入参 + 两次调用同结果）。
- `normalizeZoneRecord.test.ts`（T2，3 条）：① 非法值回落 `defaults[zone]`、合法值原样保留 ② 只保留 `PRESET_ZONES` 的键，轴外键必须被丢弃 ③ 非对象输入（`null` / `undefined` / 字符串 / 数字 / 布尔）→ 全默认。
- `presetReducerPureHelpers.test.ts`（T3，8 条）：`filterPresetTheme` 三条（只留 `THEME_PRESET_KEYS`、主题键一个不少、轴外与非主题权威键都被丢掉）；`toThemeDelta` 一条（与默认值相等的键被过滤、其余原样保留、不在默认值表里的键不参与过滤）；`clampPresetCcHeight` / `syncPresetCcHeight` 四条（下界与「可见状态控件数」联动、上界固定 400、区间内原样返回、`ccHeight` 非数字回落默认值）。
- `completeTerminalPreset.test.ts`（T4，3 条）：① 未登记视觉补全的预设原样返回（同一引用）② 合并顺序 `TERMINAL_COMPLETION → preset.theme → TERMINAL_VISUAL_COMPLETION[name]`（三层各一条断言）③ `ccLayout` 是深拷贝、改返回值不影响原预设。

## 证据

- commit：**无**（施工单 §一-6：不 commit、不 push、不开 PR）。改动留在 `feat/preset-v2` 工作树，基线 `0579951d`。
- 测试：
  - `bun run build:example-plugin` → EXIT=0
  - `bun run build` → EXIT=0
  - `bun run check:solid` → EXIT=0
  - `bun run test` → EXIT=0，`Test Files 576 passed (576)` / `Tests 3835 passed (3835)`
  - 4 个新文件单跑 → 5 passed / 3 passed / 8 passed / 3 passed
  - 反向验证两次（降级 → 变红 → 还原 → 复绿），输出见上
- 手工验证：无（本刀不涉及 UI 与运行时行为，全部由单测与门禁覆盖）

## 与 spec 的偏差

1. **施工单写「改动 7 个文件」，实际是 5 个。** 单子把 B1～B6 当成了 6 个文件，但 B3/B4/B5 三个函数同在 `src/domains/theme/presetReducer.ts`。按单子 §3.4 自己的位置表，真实是 **5 个文件 / 7 处改动**（1 个拆分 + 6 个加 `export`）。产物与单子的**改动点清单**逐条一致，不存在漏做；差的只是单子自己的文件计数。**不改单子**，记录于此。
2. **基线已重钉。** 开工时基线已由 `f148fa12` 前移到 `0579951d`（拉取远端 main 合并所致），基线测试数由 `569 files / 3768 passed` 变为 `572 files / 3816 passed`。开工前已逐条核对 7 个函数位置、消费者行号、脚手架行号**全部未漂移**，并已就地更新施工单与 v1.1 规范。详见单子页首「基线重钉」注记。
3. **新测试多写了又收回。** T2 初稿曾额外覆盖「返回键集合恒等于 PRESET_ZONES」「数组输入」「谓词换用」三条，因超出单子列出的三条行为、且其中一条用了 `as unknown as` 的退化断言，按铁律 1/5 收回，只留单子要求的三条。

## 未解问题

1. **`completeTerminalPreset` 的拷贝防线比单子点名的更宽。** 除了 `ccLayout` 用 `structuredClone`，`ccHidden` 用 `[...]`、`ccScale` 用 `{...}` 做了浅拷贝，意图同为「防止预设之间共享引用」。施工单 T4 第 ③ 条只点名 `ccLayout`，本刀按单子只测了 `ccLayout`；`ccHidden` / `ccScale` 的拷贝行为**当前没有被直接测试锁住**，建议刀4（名单换代，会碰 `ccScale`）顺手补上。
2. **旧基线数字对不平。** 施工单原写 `569 files`，但按 `src` 下 559 个 `*.test.ts(x)` + `scripts` 下 11 个 `*.test.mts` 应为 570。这个差 1 未找到来源，已随基线重钉一并作废，不影响本刀。
3. **已知偶发红 #141**（[issue](https://github.com/AlchemistCxC/Pylon-co-works/issues/141)）：`src/renderers/solid-workbench/chat/__tests__/issue55.rowSetPurity.solid.test.tsx` 全量跑下负载敏感偶发超时。本刀 4 次全量跑（基线 1 次 + 门禁 1 次 + 早期 2 次）中**只红过 1 次且在本刀开工前**，开工后两次全量均绿。该问题与本刀无关，修不修归 #141。

## 并行交集

本刀碰过的共享文件，供其他贡献者避让（**B 类 6 个函数只加 `export`，函数体零改动**）：

- `src/application/transactions/applyGlobalPreset.ts`（A 类，改动最大）
- `src/domains/workbench/appearance.ts`
- `src/domains/theme/migration.ts`
- `src/domains/theme/presetReducer.ts`
- `src/presets.ts`
- 新增：`src/domains/workbench/__tests__/selectCcProperties.test.ts`、`src/domains/theme/__tests__/normalizeZoneRecord.test.ts`、`src/domains/theme/__tests__/presetReducerPureHelpers.test.ts`、`src/__tests__/completeTerminalPreset.test.ts`

**后续刀的直接前置**：刀2（拆 `src/presets.ts`）依赖本刀给出的 `export function completeTerminalPreset`；刀4（名单换代）要改 B1 `selectCcProperties`、并会碰 `ccScale`（见「未解问题 1」）；刀5/刀6 要碰 B2～B5。这些函数现在都能被单测直接 import，改动时有网。
