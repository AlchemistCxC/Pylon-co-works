# Dev Record — #109 预设系统 V2 · 刀1 插件化地基（`context.presets` 能力槽）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/109-preset-v2-cut1-plugin-channel.md`

## 元信息

- issue：[#109](https://github.com/AlchemistCxC/Pylon-co-works/issues/109)（施工单 `01-施工单-刀1-插件化地基.md` 在用户工作区，不入库）
- 分支：`feat/preset-v2`
- 提交范围：基线 `ee9a4429`（刀0 施工域声明之后）
- 日期：2026-09-17
- 署名：**Popper**（翻译会话 = 独立核验与记录）｜施工：工作者会话（`/role:worker`，两轮交付）
- 前置：**刀0 已完工并验收**（同分支，见 `109-preset-v2-cut0-pure-functions.md`）

## 目标与范围

**要达成什么**——给插件激活上下文新增第 **23** 个能力槽 `context.presets`，让插件能把预设注册进统一注册表：**照抄 `ccWidget` 那一套**（types / registry / plugin API / barrel / 装配 / 出厂插件 / 单测）。**数据不动、UI 不动、消费方一处不改。**

**不做什么**——不搬数据（`RAW_GLOBAL_PRESETS` / `GLOBAL_PRESETS` 原地不动）；不改消费方（`Settings.tsx` / `applyGlobalPreset.ts` / `TemplateLibrary.tsx` / `workbenchSkinContract.ts` 与既有测试）；不动 UI；不做权限模型；不碰 `PresetCaptureScope`；不 commit / push / PR（由用户决定）。

## 改动清单

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `src/plugin-runtime/preset/presetTypes.ts` | `PresetPayload` / `PresetContribution` / `ResolvedPreset`（框架中立最小形状） | 新增 |
| `src/plugin-runtime/preset/presetRegistry.ts` | `PresetRegistry` 包 `ReactiveRegistryStore`：`normalize` 校验（id 非空且无首尾空格、label 非空）+ `Object.freeze`（含 payload 深一层） | 新增 |
| `src/plugin-runtime/preset/pluginPresetApi.ts` | `PluginPresetApi`（只暴露 `registerPreset`）+ 工厂（有 transaction 走事务，否则直连；disposable 挂 `scope`） | 新增 |
| `src/plugin-runtime/preset/index.ts` | 3 行 barrel | 新增 |
| `src/plugin-runtime/preset/__tests__/presetRegistry.test.ts` | 3 用例：校验失败（空 id / 带空格 id / 空 label）+ 注册冻结 + resolve + dispose 回收 | 新增 |
| `src/plugins/core/preset/builtinPresetPlugin.ts` | `createBuiltinPresetPluginDefinition()`（`builtin.pylon-presets`）+ `registerBuiltinPresets` —— **本刀注册 0 条**（纯骨架，数据接入留刀3） | 新增 |
| `src/plugins/core/preset/__tests__/builtinPresetPlugin.test.ts` | 2 用例：通路（激活→0 条→卸载→0 条）+ 探针插件（注册→读回 1 条 + `ownerPluginId` 正确→卸载归零） | 新增 |
| `src/plugin-runtime/pluginHostServices.ts` | B1：`RuntimeRegistries` 加 `readonly presetRegistry` | 修改 +2 |
| `src/plugin-runtime/runtimeServices.ts` | B2：构造 `new PresetRegistry()` + `getPresetRegistry()` | 修改 +3 |
| `src/plugin-runtime/pluginActivationContext.ts` | B3：`PluginActivationTransactions` 加 `presets` 事务位；`BuiltinPluginActivationContext` 加 `presets` API；上下文构造接线 | 修改 +5 |
| `src/plugin-runtime/shadowUpdate.ts` | B4：热插拔 shadow 事务字面量补 `presets` 一行 | 修改 +1 |
| `src/sdk/testing.ts` | B5：SDK 替身上下文补 `presets: recordingApi('presets', recorded)` 一行 | 修改 +1 |

**5 个修改全部 +N -0（零删除）；7 个新增文件。** 本刀无消费方（新目录全仓零 import），故**行为零变化**。

## 方案要点

- **能力槽照 `ccWidget` 全套**：`ReactiveRegistryStore` + `RegistryTransaction` + `PluginScope` 自动回收，一行不新造轮子。
- **装配点是 5 处，不是施工单原先写的 3 处**：`pluginHostServices` / `runtimeServices` / `pluginActivationContext`，外加**编译强制**的两处 —— `shadowUpdate.ts`（构造完整 `transactions` 字面量，全仓唯一）与 `sdk/testing.ts`（SDK 替身上下文，`satisfies BuiltinPluginActivationContext` 全仓唯一）。两处各加一行即对称通过。
- **出厂插件的两半**：`createBuiltinPresetPluginDefinition()`（规范形，供 `TestPluginRuntime.activateBuiltin` 与将来装配）+ `registerBuiltinPresets(context)`（真正动手的那句）。**生产装配留刀3** —— 现成先例是 `builtinPylonRenderers.ts:58` 那样，由某个第一方产品包在自己的 `activate` 里直接调 register。
- **A6 注册 0 条**（不引入假数据）；**A7 两个用例**（通路 + 测试内探针），以此消解施工单 §六#2 与 §七 的互斥。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁 1 `build:example-plugin` | ✅ EXIT=0 |
| 门禁 2 `build`（`tsc -b && vite build`） | ✅ EXIT=0（built in 18.18s） |
| 门禁 3 `check:solid` | ✅ EXIT=0 |
| 门禁 4 `test` | ✅ EXIT=0，**578 files / 3840 passed / 0 failed**；**连续 5 轮全量全绿**（工作者 2 + 翻译 3），满足 `vitest.config.ts:55` 的出口判据「无 retry 连续 5 轮」 |
| 红线① `rg "from '.*domains/theme" src/plugin-runtime/preset` | ✅ 0 命中 |
| 红线② `rg "PresetBundleV2" src/plugin-runtime` | ✅ 0 命中 |
| 范围 | ✅ 改动 5 / 新增 7；既有测试**零修改**；刀0 在制品与禁区（`src/ui-demo/`、`src/layout-sketch/`、`docs/前端接口地图.md`）一行未碰 |
| 反向验证 | ✅ 共 7 次「改坏→变红→还原→复绿」：工作者 5 次（A5 三次、A7 两次）+ 翻译 2 次（`presetRegistry` 的 id 空白校验、`register` 写入篡改 label），还原后指纹一致 |
| 翻译独立核验 | ✅ 全部重跑（非转述）：门禁四步 + 红线 + 逐文件 `--numstat` + A7 用例逐字比对裁决写法 |

## 测试处置

**未修改、未删除任何既有测试。** 新增 2 个测试文件、共 5 用例（A5 的 3 + A7 的 2）；全量从刀0 结束时的 576 files / 3835 passed 变为 **578 / 3840**（+2 文件 / +5 用例，与新增量一致）。

## 与 spec 的偏差

1. **装配点 3 → 5 处**（上述两处编译强制点）。施工单已就地订正（§二 装配④、§四-B4/B5、§六#5/#7），非擅自扩大范围。
2. **§六#2 与 §七 互斥**（注册 0 条 vs 能读回贡献）→ 裁决：A7 写两个用例，生产代码仍 0 条（§六#6）。
3. **B3 行数口径**：施工单写「2~3 行」，实际 5 行（2 import + 2 接口字段 + 1 处上下文构造）——已就地订正为「B1~B3 各 2~5 行」。

## 未解问题

1. **`check:solid` 会跳过未跟踪文件（本轮 22 个，含本刀新增的两个目录）** → 新代码目前只被 `tsc -b` 覆盖，**未被边界脚本审计**；`git add` 后再跑一次才是权威结果。这是门禁的结构性盲区，非本刀引入。
2. **新抖动点**：本刀验收首轮全量撞到 `src/components/__tests__/WorkspacesPanel.test.tsx`（目录选择器用例）+ `issue55.rowSetPurity`（骨架屏未清除）各 1 例；单跑各绿、随后连续 5 轮全绿。`issue55` 已有 [#141]；**`WorkspacesPanel` 是新出现的，建议登记 issue**。
3. **`createBuiltinCcWidgetPluginDefinition` 无生产消费者**（中控控件那套的同类残留）→ 建议上报 ACh 线处置（删掉，或把 P2 装配接上）。本刀照现状对称实现，未动它。

## 并行交集

本刀碰过的共享文件（供其他贡献者避让；`shadowUpdate.ts` / `sdk/testing.ts` 只加一行）：

- `src/plugin-runtime/pluginHostServices.ts`、`runtimeServices.ts`、`pluginActivationContext.ts`、`shadowUpdate.ts`
- `src/sdk/testing.ts`
- 新增：`src/plugin-runtime/preset/`（5 文件）、`src/plugins/core/preset/`（2 文件）

**后续刀的直接前置**：刀2（拆 `presets.ts`）与本刀无冲突；刀3（数据搬家）要靠本刀的能力槽**在某个第一方产品包的 `activate` 里加一行 `registerBuiltinPresets(context)`** 才算真正接通。
