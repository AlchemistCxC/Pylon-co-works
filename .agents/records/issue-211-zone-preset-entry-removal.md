# Dev Record — #211 刀7 前置：自定义区域预设删除入口

> 入库保留。施工单：仓外 `预设修正/预设系统V2/07a-施工单-刀7前置-自定义区域预设删除入口.md`。

## 元信息

- issue：#211（总 issue #109；用户 2026-09-20 指令登记，标题 `feat(preset): #109 刀7 前置——自定义区域预设删除入口`）
- 分支：`feat/preset-v2.7`（自 `main@399d1423` 开——刀6 已随 PR #210 合并）
- 提交范围：`399d1423..<待收口>`（本轮存档由翻译按批安排，工作者不提交）
- 日期：2026-09-20

## 目标与范围

**做**：给刀6 的自定义区域预设补删除入口——store 纯函数 + 薄壳、`ZonePresetRow` 行内两段式确认、出现条件三态（仅自定义来源、普通条目被选中才出现、Q8 灰显占位常驻）、测试。

**不做**：出厂条目不可删（铁律 1）；不动刀6 派生规则 / 池结构 / `pickZoneFields` / 预设「值」；不做编辑历史条目（改值 / 重命名）；不碰全局删除链；不给 Q8 占位条目加开关；不新增样式家族。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/zones/zonePresetPool.ts` | 新增 `isCustomZonePresetEntry`（出厂/自定义唯一判据）、`ZonePresetRemovalState/Patch` 类型、`removeZonePresetEntryReducer`（形态对齐 `removeCustomPresetReducer`） | 修改 |
| `src/zones/index.ts` | 门面导出上述符号与类型 | 修改 |
| `src/store.ts` | 新增 `removeZonePresetEntry(id)` 薄壳；未命中时 reducer 回原引用 ⇒ 不写状态 | 修改 |
| `src/components/Settings.tsx` | `ZonePresetRow` 加 `onRemoveEntry` 与 `pendingDeleteEntryId`；删除入口 + 行内两段式确认（复用 `.set-confirm.set-confirm-inline` / `.set-confirm-actions` / `role="alertdialog"`）；4 处调用点接线 | 修改 |
| `src/zones/__tests__/zonePresetPool.test.ts` | 新增 7 条：删除闭环+持久化、失去基准、出厂不可删、两段式确认、取消路径、出现条件三态、Q8 占位可删 | 修改 |
| `.agents/L.md` | 本单文件域声明（开工时单独提交 `530d4717`） | 修改 |

## 方案要点

1. **删除闸门是结构性的，不是分支判断**：出厂条目由构建时派生表持有、**从不进入 `zonePresetEntries`** ⇒ `removeZonePresetEntryReducer` 里的 `filter` 天然删不掉它们；UI 侧另有一条显示闸门（`isCustomZonePresetEntry`）。两道闸门都单测锁住。
2. **出现条件（`deletable`）**：`isCustomZonePresetEntry(entry) && (entry.stale === true || selected)`。普通自定义条目「被选中才出现」（那排 chip 本来就挤）；Q8 灰显占位条目常驻——施工单 §二.5 明确「占位条目应可被删（那是它唯一的自然出口）」，而占位条目不可应用、永远不可能「被选中」，故必须例外。出厂条目任何情况下都不进入该分支。
3. **删除后该区失去基准**（★ 判断点，见「与施工单的偏差」）：`appliedPreset[zone]=''` + `custom[zone]=true`，**字段保留现值**——与全局删除链 `removeCustomPresetReducer` 同语义（其确认文案即写「引用它的区域会保留现值但失去预设基准」）。
4. **无副作用写盘**：未命中 ⇒ reducer 原样返回入参引用 ⇒ store 薄壳跳过 `set`，`appliedPreset` 引用不变（测试以此断言）。
5. **不新增样式**：确认块 100% 复用全局先例的类（`.set-confirm` / `.set-confirm-inline` / `.set-confirm-text` / `.set-confirm-actions` / `.ps-btn.sm.danger`），CSS 一个字符未改。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 存一条自定义 → 删除 → 行内两段式确认 → 确认后从池里消失 | ✅ |
| 持久化：删除后写回可见、重载后不复活 | ✅ `localStorage['pylon-theme']` 不再含该 id，且读入路径还原为 `[]` |
| 出现条件三态（出厂 0 / 自定义未选中 0 / 自定义被选中恰好 1） | ✅ |
| Q8 灰显占位条目可被删除 | ✅ |
| 取消路径：不删、无残留确认框 | ✅ |
| 全局删除链未被影响 | ✅ `git diff --stat -- src/customPresets.ts src/domains/theme/presetReducer.ts` 为空；`Settings.tsx` diff 无 `set-custom-preset` / `removeCustomPreset` / `pendingDeletePresetId` 命中 |
| 门禁五步全绿；契约快照重拍内容零 diff | ✅ |
| 新增测试反向验证四段 | ✅ 7 处改坏（N1–N7），7 条新测试每条至少一处变红 |
| `git status --porcelain` 只含本单文件 | ✅ 另见 3 条禁区未跟踪项原样未动 |

## 测试处置

- **新增** 7 条于 `src/zones/__tests__/zonePresetPool.test.ts`（该文件刀6 建立，现 19 条），全部走反向验证 N1–N7。
- **既有测试零修改、零删除**：本单未改任何既有断言。刀6 的 12 条与 Settings 相关既有文件（`Settings.globalPresetMenu` / `Settings.customPreset` / `B-03-settings-dialog` 等）实测全绿。

## 证据

- 门禁：`bun run lint`（0 error）/ `build:example-plugin` / `bun run build` / `bun run check:solid` / `bun run test`
- 反向验证：N1–N7，见施工汇报
- 快照：`bun scripts/check-workbench-theme-contract.mts --write` → 内置预设 10 个、字段 191 个；`git diff` 仅 `generatedAt` 时间戳（已还原）

## 与施工单的偏差

1. ★ **删除后该区失去基准**：施工单 §一.1 只说「对齐 `removeCustomPreset` 的形态」、未写 `appliedPreset`/`custom` 的处置；我按全局删除链的**语义**实现（`appliedPreset=''` + `custom=true`、保留现值）。理由：不这么做会留下**悬空基准**——该区 `appliedPreset[zone]` 指向已不存在的 id，于是区域内既无 active chip、`isCustom` 又是 `false`（「自定义」chip 也不显示），界面表现成「还在基准上」而实际没有基准。若要求删除后**完全不动基准**，请回一句，我改（改动点集中在 reducer 那 10 行）。
2. **占位条目的删除入口常驻**（§一.2 说「只在被选中时出现」）：占位条目不可应用、永不「被选中」，若同样要求选中则 §三「Q8 灰显占位条目可被删除」无法满足。故按 §二.5 的例外处理。
3. **确认块按钮外包了一层 `.set-confirm-actions`**：全局先例的两个按钮是 `.set-confirm-inline` 的直接子元素；施工单 §一.2 点名要复用 `.set-confirm-actions`，故加上该包装层（`.set-confirm-inline` 的 `gap:6px` 与 `.set-confirm-actions` 的 `gap:6px` 相同，视觉等价）。

## 未解问题

- 「编辑历史条目」（改值 / 重命名）仍是未来范畴。
- 真机（Tauri/WebView2）未跑：UI 证据取自 jsdom 挂载 + DOM 断言，未做真实窗口目视。

## 并行交集

- 触碰的共享文件：`src/zones/zonePresetPool.ts`、`src/zones/index.ts`、`src/store.ts`、`src/components/Settings.tsx`、`src/zones/__tests__/zonePresetPool.test.ts`、`.agents/L.md`
- 未碰：`src/customPresets.ts`、`src/domains/theme/**`（全局删除链）、`src/presets/**`、`src/zones/pickZoneFields.ts`、`src/themeFieldDefs.ts`、首方 CSS（零改动）、`src/renderers/**`、`src-tauri/**`、`tools/**`、`docs/说明书/**`（无「区域预设 / 局部预设」表述，0 处需同步）
