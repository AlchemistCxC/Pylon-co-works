# Dev Record — #238 中控元件两级定义表 · 刀1（结构步）

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\元件定义表\01-施工单-刀1-两级定义表立表.md`
> 规范：同目录 `00-施工规范-中控元件定义表-v1.0.md`；结构冻结件：同目录 `03-结构-定义表骨架-20260922.md`

## 元信息

- issue：[#238](https://github.com/AlchemistCxC/Pylon-co-works/issues/238)
- 分支：`feat/cc-widget-definition-table`（基于 `origin/main @ 94d88ede`）
- 提交范围：`94d88ede..e0f81d3d`（`6e26e6e4` L.md 声明 → `698f7c36` 立表 → `e0f81d3d` 测试类型修正）
- 日期：2026-09-22

## 目标与范围

**目标**：把中控元件的「名字 / 默认落位 / 有哪几个 / 各自管哪些字段」收成**一张两级定义表**（组 + 成员），
7 份平行名单与 2 份平行名字/位置全部改派生。**行为零变化**（像素级）。

**不做**（施工单 §一「不动的东西」+ 规范 §2）：

- 不删死数据（`BUILTIN_CC_WIDGET_DEFINITIONS` / `widgetCatalogView.ts` / `.modern-command-dock` 一族 CSS —— 第③件）
- 不动插件契约面（`plugin-runtime/cc-widget/**`）、不动状态左行槽位（第②件）
- **不把控件里硬编码的 12px 间距收编**（停手条件 7，见「与 spec 的偏差」）
- 不改属性面板表现、不 bump 任何版本号、不改 `ccLayout` 版本白名单
- 不碰 `src/ui-demo/`、`src/layout-sketch/`、`docs/前端接口地图.md`

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/cc/widgetDefinitions.ts` | 两级定义表本体（组 8 行 + 成员 20 行）＋ 派生名单／标签表／属性表单／系统字段桶；成员层与组层类型 | 修改（重写，表是新增内容） |
| `src/domains/cc/widgetCatalog.ts` | `BUILTIN_CC_WIDGET_DEFINITIONS` 的 name/category/placement 与两个贡献行的 label/category/placement 改查表；`placement()` 局部工厂删除 | 修改 |
| `src/ccLayoutState.ts` | `CC_REGISTERED_SLOT_IDS` 改为转出表派生值；`DEFAULT_CC_LAYOUT.placements` 由表 `defaultPlacement` 派生（键序＝表序） | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | 删本地 `WIDGET_LABELS` / `ALWAYS_VISIBLE_STATUS_WIDGETS` / `EMPTY_STATE_HIDDEN_WIDGET_IDS`，改消费表派生值 | 修改 |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 不变量与零变化锁（23 用例） | 新增 |
| `.agents/L.md` | 施工范围声明（单文件提交） | 修改 |

## 方案要点

1. **表住哪**：`src/domains/cc/widgetDefinitions.ts`（既有之家），不新建文件。
2. **依赖方向（头号雷）**：表对 `src/themeFieldDefs.ts` 只有 `import type { ThemeFieldKey }`（类型擦除）。
   字段键本身是字符串；「83 个全覆盖、无重叠、合法」由测试机检。
   链方向：`themeFieldDefs → ccHeightState → widgetDefinitions`（运行时），表**不反向**。
3. **行工厂保字面量类型**：`widgetGroup<Id, Type, Rail, Draggable>()` 让 `id/type/rail/draggable` 保持字面量，
   其余栏位仍走 `CcWidgetGroup` 的上下文类型检查（写错字段键/槽位名当场编译报错）。
   `CcWidgetId` / `CcRegisteredSlotId` 由 `Extract<行联合, {…}>` 派生 —— 不再有人手写的 id 清单。
4. **三处派生点**：
   - `CC_WIDGET_IDS` = 内置轨可拖行；`CC_REGISTERED_SLOT_IDS` = 注册轨可拖行（不占槽的组进不来）
   - `DEFAULT_CC_LAYOUT.placements` = 各行 `defaultPlacement`（键序＝表序，契约快照按此序落盘）
   - `WIDGET_LABELS`（删）→ `CC_WIDGET_LABELS`；常态放行 / 空态隐藏 → 表里的两个布尔栏位
5. **字段归属**：单个部件的组用「本体成员」承担字段归属（骨架「成员=无」指**没有子部件**；
   不变量 1 要求每个字段落在**某个成员的 fields** 里）。20 个成员 = 9（输入栏）+ 2×5（模型/思考强度/权限 → 触发器+菜单）
   + 2（发送按钮：按钮本体 + 图标层）+ 1×4（背景板本体 / 用量胶囊 / 提示行）。
6. **跨元件系统字段桶** `CC_SYSTEM_FIELDS`（7 项）：`ccLayout` / `ccHidden` / `ccScale`（名单本体）
   + 原「信息行」的 4 项（`ccStatusFontSize` / `statusBg` / `statusBgImage` / `footerLayout`，作用面是整条状态行）。
7. **中文名照抄现状**：`cc-surface` = 「中控本体背景板」、`mode` = 「权限模式」（骨架单元格是简写，见偏差 A）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 不变量 1：83 字段恰好一个归属行 | ✅ 测试绿（`83 个 cc 字段每一个恰好有一个归属行，无遗漏`） |
| 不变量 2：无字段重叠 | ✅ 测试绿（`同一字段不得出现在两个归属行里`） |
| 不变量 3：控件 7 + 容器 1 = 8，与三条轨逐条一致 | ✅ 测试绿 |
| 不变量 4：成员/容器不进三份名单 | ✅ 测试绿（含「成员 id 不得落进常态放行/空态隐藏」） |
| 不变量 5：恰 1 个容器不占位、不进工具条 | ✅ 测试绿 |
| 不变量 6：锚点无环、终止于 `cc-surface` | ✅ 测试绿 |
| 零变化 1：默认布局逐条不变 | ✅ 测试锁 `DEFAULT_CC_LAYOUT` 全量 `toEqual`（含键序） |
| 零变化 2：编辑工具条仍是 6 条 | ✅ 测试锁 `['input','model','reasoning','mode','tokens','cc-send-button']` |
| 零变化 3：空态/常态显隐实际效果不变 | ✅ 测试锁两份名单的成员集合 |
| 零变化 4：中文名逐字不变 | ✅ 测试锁 `CC_WIDGET_LABELS` 全表 + 目录三份 |
| 零变化 5：属性面板字段集与顺序不变 | ✅ 测试锁 5 个控件的 `kind:key` 序列 + cli 三项 `showIf` |
| 零变化 6：契约快照除 `generatedAt` 外逐字节 | ✅ 重拍 diff 仅 1 行（`generatedAt`），已还原快照 |
| 零变化 7：全量测试对账 | ✅ 基线 623 文件/4678 通过(+1 todo) → 本刀 624/4701(+1 todo)：+1 文件、+23 用例、0 删除 |
| 门禁五步 | ✅ 全绿（见「证据」） |
| 依赖方向证据 | ✅ `grep` 只剩 `import type`；冒烟输出非空 |
| 开发记录 | ✅ 本文件 |
| 《中控元件总表》更新 | ✅ 仓外 `任务\工作台优化\中控元件总表.md`（§1 / §2 / 新增 §2.1 成员层 / 「7 个」出处 / 附件那条） |
| issue 评论区回写 | ✅ #238 |

## 测试处置

- **既有测试：零修改、零删除**。（施工单点名的 10 个文件全部原样通过；`widgetCatalogView.test.ts` —— 属第③件 —— 也保持绿。）
- **新增**：`src/domains/cc/__tests__/widgetDefinitionTable.test.ts`（23 用例）。已做反向验证（见下）。

## 证据

- **commit**：`94d88ede`（base）→ `6e26e6e4` / `698f7c36` / `e0f81d3d`
- **门禁（冻结态 `e0f81d3d`，按施工单顺序）**：

```text
$ bun run lint                    → LINT_EXIT=0（1 warning，在他人在途文件 RightRailHost.tsx，非本刀）
$ bun run build:example-plugin     → EP_EXIT=0
$ bun run build                    → BUILD_EXIT=0（含 build:wasm 已最新 跳过）
$ bun run check:solid              → SOLID_EXIT=0
$ bun run test                     → TEST_EXIT=0；Test Files 624 passed (624)；Tests 4701 passed | 1 todo (4702)
```

- **契约快照重拍比对**（零变化 6）：

```text
$ bun scripts/check-workbench-theme-contract.mts --write
$ git diff -- src/renderers/solid-workbench/__fixtures__/
-  "generatedAt": "2026-09-19T14:47:25.095Z",
+  "generatedAt": "2026-09-22T05:37:23.502Z",
（仅此一行；随后 git checkout 还原，本刀不改动快照）
```

- **全量对账（零变化 7）**：把本刀 5 个文件临时 stash 掉（工作树回到 `origin/main`）实测基线：

```text
基线：Test Files 623 passed (623)；Tests 4678 passed | 1 todo (4679)
本刀：Test Files 624 passed (624)；Tests 4701 passed | 1 todo (4702)
增量 = +1 文件 / +23 用例 / todo 不变 / 0 删除
```

- **反向验证**（改坏 → 变红 → 改回；三次都在冻结态重做，改回后 md5 复核＝`7f36617486f1a65832fcb51d63283327`）：

```text
A 把字段挂到错的成员（cliPromptColor: cli-prefix → cli-lines）
  × 成员 ↔ 字段的归属逐条锁定（挂到错的成员即红）
  AssertionError: expected { …(20) } to deeply equal { …(20) }
  Tests 1 failed | 22 passed (23)

B 把成员塞进名单（EMPTY_STATE_HIDDEN 追加 'surface-body'）
  × 成员 id 不得落进常态放行 / 空态隐藏这两份名单
  AssertionError: expected [ 'surface-body' ] to deeply equal []
  × 常态放行 / 空态隐藏的实际效果不变（成员集合一致）
  Tests 2 failed | 21 passed (23)

C 删掉一个成员（input/cli-lines）
  × 83 个 cc 字段每一个恰好有一个归属行，无遗漏
  AssertionError: expected [ 'ccBg', …(78) ] to deeply equal [ 'ccBg', …(81) ]
  × 逐组字段计数 / × 成员 ↔ 字段归属锁定 / × 属性表单指向的字段必须由本组成员拥有
  Tests 4 failed | 19 passed (23)

改回后：Tests 23 passed (23)，EXIT=0，md5 与冻结态一致
```

- **依赖方向 + 冒烟**：

```text
$ grep -rn "themeFieldDefs\|store.ts" src/domains/cc/
src/domains/cc/widgetDefinitions.ts:28:import type { ThemeSettings } from '../../store.ts'
src/domains/cc/widgetDefinitions.ts:29:import type { ThemeFieldKey } from '../../themeFieldDefs.ts'
（其余命中均为注释；测试文件另有 import，不进运行时图）

$ bun -e "import './src/themeFieldDefs.ts'; const m = await import('./src/domains/cc/widgetDefinitions.ts'); console.log('ok', m.CC_WIDGET_IDS)"
ok [ "input", "model", "reasoning", "mode", "tokens" ]
```

- **说明书同步**：`grep -rn "CC_WIDGET_IDS\|widgetDefinitions\|widgetCatalog\|domains/cc\|ccLayoutState" docs/说明书/` → **零命中**，
  该区域未描述中控元件名单，无漂移面（不需改动）。

## 与 spec 的偏差

- **A. 两处中文名取「现状字面量」而非骨架单元格的简写**。骨架 §2 写 `cc-surface` = 「中控本体」、`mode` = 「权限」，
  但代码现状是「中控本体背景板」（`widgetCatalog.ts`）与「权限模式」（`WIDGET_LABELS`）。
  骨架 §4 栏位字典自己定义了「中文名**照抄现状**（渲染出来的字逐字相同）」，而零变化第 4 条要求逐字不变，
  故取现状值。**若翻译侧本意是要改名，属内容步（会改可见文字）。**
- **B. 单件组补「本体成员」承担字段归属**。骨架 §2 对 `cc-surface` / `tokens` / `cc-command-hint` 标「成员=无」，
  读作「没有**子部件**」；施工单不变量 1 要求每个字段落在**某个成员的 fields** 里，故为这三个组各建 1 个本体成员
  （`surface-body` / `pill` / `hint-line`）。成员仍不进任何名单，不变量 4/5 不受影响。
- **C. 12px 间距不收编（按停手条件 7 退回）**。表里记了值（模型 0 / 思考强度 12 / 权限 12 / 用量 0），
  **但不消费**：控件里的 `PERMISSION_GAP_PX` / `REASONING_GAP_PX` 原地生效。
  两条理由：① 该文件（`WorkbenchWidgets.solid.tsx`）**不在本单的「要改」文件域**内；
  ② 若改成"由渲染统一加"，则 margin 从控件根元素移到 `.cc-widget` 外层，**像素级相同需要实机量测**（本刀不具备该证据）。
  收编挪到内容步（届时可改为"控件读表里的值、仍写在同一元素上"，DOM 不变，天然像素级相同）。
- **D. 环境侧（非代码偏差，但影响复现）**：本机原先缺 `wasm-pack` 与 `wasm32-unknown-unknown`，
  `bun run build` / `bun run test` 的 globalSetup 会硬失败（issue #220 引入的门禁前置）。
  已按脚本给出的补齐命令安装（`rustup target add wasm32-unknown-unknown`、`cargo install wasm-pack`），
  并下载了 wasm-pack 需要的 binaryen（首次走 GitHub release 下载，断过一次，重试成功）。**仓库文件未被改动。**

## 未解问题

1. 偏差 A 的字面量（「中控本体背景板」/「权限模式」）是否要改，待翻译/用户确认；要改属内容步。
2. 偏差 C 的间距收编（含"控件读表里值"的像素级安全做法）留给内容步。
3. 「命令行提示」归位（删裸渲染 `commandHint()` + 工具条 6→7）留给内容步（规范 §11.7），本刀 `draggable: false`。
4. `CC_SYSTEM_FIELDS` 里 4 个状态行级字段的收尾（2 项废弃 / 字号收窄 / 底排布改由锚点表达）留给内容步。
5. 中控另两件（状态左行撤槽、死数据清理）与本件文件重叠，**不得并行**；顺序 = 本件 → 状态左行 → 死数据清理。

## 并行交集

本刀触碰的共享文件（供避让）：

- `src/domains/cc/widgetDefinitions.ts`、`src/domains/cc/widgetCatalog.ts`、`src/ccLayoutState.ts`、
  `src/renderers/solid-workbench/input/ControlCenter.solid.tsx`、`.agents/L.md`

**未触碰**：`src/plugin-runtime/cc-widget/**`、`src/themeFieldDefs.ts`、`src/ccHeightState.ts`、
`src/domains/workbench/appearance.ts`、`ControlCenter.css`、`WorkbenchWidgets.solid.tsx`、
`src/components/cc/**`、`src/ui-demo/`、`src/layout-sketch/`、`docs/前端接口地图.md`。
