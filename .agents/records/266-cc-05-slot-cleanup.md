# Dev Record — #266 CC-05 清出厂数据退场字段 `slot`

> 施工单：`E:\Acode\FILES\任务\工作台优化\待办\18-施工单-CC-05清出厂数据退场字段slot.md`

## 元信息

- issue：#266（CC-05）
- 分支：`refactor/cc-05-slot-cleanup.1`（自 `origin/main @ 05369cd3` 新建，已 `--unset-upstream`）
- 提交范围：**随本单存档点提交**（用户 2026-10-03 明示；sha 随下一笔回填；基点 `05369cd3`）
- 日期：2026-10-03

## 目标与范围

把「槽位时代」历史键 `slot` 从**数据 / 类型 / 守卫放行**三处一并退场：出厂数据 36 行、
`CcWidgetPlacement.slot?`（含 @deprecated 行）、守卫键集白名单的 `LEGACY_KEYS`。
运行时本就不读该键 ⇒ **零视觉、零功能变化**。

不做（施工单 §二）：不重造生成器；不动任何 `order / offsetX / offsetY` 值；不碰渲染器槽位
概念（`renderer.slot.*` 错误码 / `rendererSlots` / `rendererSettingsCatalog` / `surface.slotId`）；
不删迁移/结构性测试（夹具最多按编译红点最小修）；不碰 `src-tauri/`。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/theme/zones/factory/terminal-cc.ts` | 各 `ccLayout.placements` 记录里的 `"slot"` 键行 ×30 | 删除 |
| `src/domains/theme/zones/factory/gui-cc.ts` | 同上 ×6 | 删除 |
| `src/domains/cc/ccLayoutState.ts` | `CcWidgetPlacement` 接口：删 `slot?` 与 @deprecated 行；接口注释重写为退场说明 | 修改 |
| `src/domains/theme/zones/__tests__/factoryZonePresetLayoutGuard.test.ts` | `POSITION_KEYS` 注释更新、删 `LEGACY_KEYS`、键集用例收紧（`allowed = POSITION_KEYS`）与用例名同步 | 修改 |
| `src/__tests__/presetAssembly.test.ts` | `dirtyCcLayout()` 直赋里的 `slot: 'actions'` 脏键（编译红点最小修，dirty 意图 = `order: 9` / `offsetX: 12` 原样保留） | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 契约快照连带清（接续单 19）：42 行死 `"slot"` 退场 + `generatedAt` 重拍（脚本产出） | 修改 |
| `.agents/records/266-cc-05-slot-cleanup.md` | — | 新增 |

## 方案要点

- 三处一起收才有意义：数据清了，类型里的只读历史键失去存在理由（原注释理由 2
  「出厂数据类型是 `Partial<ThemeSettings>`、删键会编译报错」随之消失），键集白名单才能收紧——
  收紧后谁把 `slot` 写回数据会被守卫当场抓（反向验证已证，见下）。
- 夹具红点**恰好一处**：tsc 全量只报 `presetAssembly.test.ts:118`（与施工单 §七 预判一致）。
  `dirtyCcLayout()` 的「用户拖拽过的排布」意图在 `order/offsetX/offsetY` 偏离值上，`slot`
  只是顺带脏键 ⇒ 最小修 = 删该键，不动测试结构。
- 单子 §七 点名的另四个待实跑夹具（`structuralAlignment` / `themeRehydrateAlignment` /
  `presetReducer` / `themeSchemaV8Backfill`）**tsc 与实跑均不红，一行未动**。
- `ccLayoutState.ts` 接口注释按施工单要求写明：`normalizeCcLayout` 只取
  `order / offsetX / offsetY`、其余键（含 `slot`）读盘时自然丢弃，老用户数据里的 `slot` 无影响。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `/usr/bin/grep -c '"slot"' src/domains/theme/zones/factory/*.ts` | **全 0**（11 个文件） |
| `/usr/bin/grep -rn -- "slot" src/domains/cc/ccLayoutState.ts` | 只剩注释里的历史说明，**无类型声明** |
| 守卫文件 `LEGACY_KEYS` | **0 命中**；键集用例绿 |
| 携带者 × 位置对拍条数 | 不变（6 携带者 × 7 元件，守卫 `checked` 断言过） |
| 门禁五步 | 全绿（数字见「证据」） |
| 契约快照 `--write` 后 `git diff` | `1` 增 / `43` 删：`generatedAt` 一行替换 + 42 个 `"slot"` 键行随出厂数据从快照退场（快照烘焙自出厂数据；契约比较归一化 placements，`slot` 不参与比对，见「未解问题」）。★ 接续单 19 已定**连带清**（2026-10-03 用户拍板）：重拍输出**保留**，契约脚本（不带 `--write`）复跑绿 |
| 反向验证 | 红：`factoryZonePresetLayoutGuard.test.ts:99:105`；改回后复绿 |
| 开发记录落盘 | 本文件 |

## 测试处置

- **改**（均经施工单点名）：
  - `factoryZonePresetLayoutGuard.test.ts`：键集用例收紧（删 `LEGACY_KEYS`、`allowed` 收成
    `POSITION_KEYS`、用例名与注释同步「位置记录只带 order / offsetX / offsetY」）；**另三条对拍用例一行未动**。
  - `presetAssembly.test.ts`：`dirtyCcLayout()` 删 `slot: 'actions'` 脏键（红点最小修，不删用例）。
- **未改 / 未删**任何其它测试。

## 证据

- commit：随本单存档点提交（sha 随下一笔回填）
- 测试（名称 + 退出码）：
  - 受影响六文件：`6 passed (6) / 65 passed (65)`，`EXIT=0`
  - 门禁五步（lint → build:example-plugin → build → check:solid → test）：全绿，`EXIT=0`；
    全量 `657 files / 5127 passed | 1 skipped | 1 todo (5129)`（基线同值，用例数零增减）
  - 反向验证红：用例 `#266 遗留⑦ · 出厂区域数据不许与定义表漂移 > 位置记录只带 order / offsetX / offsetY…`，
    `AssertionError: terminal/cc/claude 的「input」出现未登记的位置键: expected [ 'slot' ] to deeply equal []`，
    `factoryZonePresetLayoutGuard.test.ts:99:105`，`EXIT=1`；改回后 `5 passed (5)`，`EXIT=0`
- 手工验证：`grep -c '"slot"'` factory 目录 11 文件全 0；`git diff --stat` 两数据文件合计 `36 deletions(-)`，
  无任何其它行变动

## 与 spec 的偏差

无独立 spec（施工单即规范）。实际施工与单子完全一致：无超出改动文件的编辑，无未预判红点。

## 未解问题

- **快照死 `slot` 连带清——已定（2026-10-03 用户拍板，接续单 19）**：快照已随本单更新，42 行 `"slot"` 退场 +
  `generatedAt` 一行替换（`git diff --numstat` = `1 43`；删除行仅 `"slot"` 与 `generatedAt` 两类，无第三类），
  重拍输出保留。背景：施工单 18 预期「`slot` 不进快照」与现实不符——`workbench-skin-baseline.json` 烘焙自
  出厂数据、`ccLayout.placements` 逐键落盘（重拍前内含 42 处 `"slot"` = 7 套预设 × 6 个 placement）；契约脚本
  对 placements 做归一化比较、`slot` 不参与比对（门禁 check:solid 在快照为旧版、数据已删 `slot` 时通过），
  故清理零契约影响。快照唯一消费者是 `scripts/check-workbench-theme-contract.mts`。
- 翻译复验项（实机渲染零变化）按单子留给翻译，非本工人事项。

## 并行交集

本次碰过的共享文件（供其他贡献者避让）：`src/domains/theme/zones/factory/{terminal-cc,gui-cc}.ts`、
`src/domains/cc/ccLayoutState.ts`、`src/domains/theme/zones/__tests__/factoryZonePresetLayoutGuard.test.ts`、
`src/__tests__/presetAssembly.test.ts`。
