# Dev Record — #238 刀2 归一化解耦（结构对齐不再绑版本号）

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\元件定义表\04-施工单-刀2-归一化解耦.md`
> 规范：同目录 `00-施工规范-中控元件定义表-v1.0.md`（§7 刀划分、§4 硬约束）
> 分支**沿用** `feat/cc-widget-definition-table`（与刀1 在 `src/ccLayoutState.ts` 有文件重叠）

## 元信息

- issue：[#238](https://github.com/AlchemistCxC/Pylon-co-works/issues/238)
- 分支：`feat/cc-widget-definition-table`（刀1 的 4 个存档点 → 本刀续 3 笔）
- 提交范围：`8269c4b6..0de46d4e`（`507090a4` L.md 声明 → `27a682e7` 归一化解耦 → `0de46d4e` 测试类型写法修正）
- 日期：2026-09-22

## 目标与范围

**目标**：把「结构对齐」（补缺控件项 / 补校字段值 / 按 id 合并）从 **migrate 钩子**（只在持久化版本号变化时触发）
搬到**每次读盘无条件跑**；**删掉 `normalizeCcLayout` 的版本白名单整段**；版本号职责收窄为「数据格式版本」。

**不做**（施工单 §「不动」）：槽位（刀3）、中控渲染、插件契约面、任何中控定义表内容、任何版本号 bump。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/theme/migration.ts` | 拆出 `normalizeThemeValues`（值层对齐）与 `alignThemeStructure`（结构对齐，与版本号无关）；`themeDomainMigrate` 收窄为「一次性语义转换 + 一次幂等对齐」；版本号职责注释（含反例）；修 `ccHidden`/`ccScale` 被赋 `undefined` 建键的既存缺陷 | 修改 |
| `src/ccLayoutState.ts` | 删 `normalizeCcLayout` 的版本白名单判定；版本号职责注释（记白名单事故成因） | 修改 |
| `src/store.ts` | 抽 `THEME_MIGRATION_DEFAULTS`；persist 增 `merge`：读盘后无条件结构对齐 | 修改 |
| `src/domains/cc/__tests__/ccLayoutV8.test.ts` | 「白名单」用例**样本保留**、只改期望（逐条点名，见下） | 修改 |
| `src/domains/theme/__tests__/structuralAlignment.test.ts` | 三类构造数据等价性 + 幂等 + 不覆盖用户值 + 不改入参（12 用例） | 新增 |
| `src/domains/theme/__tests__/themeRehydrateAlignment.test.ts` | 真实 zustand 水合端到端：版本号相同（migrate 不跑）也要对齐；对齐不写盘；干净新装（4 用例） | 新增 |

## 方案要点

1. **拆分口径**（按施工单 §2.1 的两类 + 停手条件 1 的判据）：
   - **结构对齐**（搬走，与版本号无关）：`{...默认值, ...持久化}` 缺项合并、`normalizeCcLayout` 按 id 合并、
     `normalizeThemeState` 值归一化、历史字段特判、`clampCcHeight`、自定义预设归一。
   - **一次性语义转换**（留在 migrate）：**v6 的字体**（`fromVersion < 6 && globalFont === 'mono'`）——
     唯一真正"依赖版本号变了才做一次"的东西。
2. **挂钩点选 `merge`**（施工单允许 `merge` / `onRehydrateStorage` / 显式调一次）：
   读 zustand 5.0.15 源码确认 `hydrate()` 用**原始 set** 落 merge 的返回值（不写盘），
   只有真跑过 `migrate` 才 `setItem()` ⇒ **对齐不产生任何额外写盘 / 订阅广播**（这是选它而非
   `onRehydrateStorage + setState` 的决定性理由：后者会在"有变化"时多一次写盘）。
   且 `migrate → merge` 的顺序保证它跑在一次性语义转换之后。
3. **`themeDomainMigrate` 保持行为逐字段不变**（= 对齐 + 版本号规则）⇒ `migration.test.ts` /
   `themeSchemaV8Backfill.test.ts` **一行未改**（验收 §3-3）。顺序也与刀2 之前一致（旧 = A,B,C,D,E,F；新 = A,B,normalizeThemeValues(C…F)）。
4. **白名单退场**：`normalizeCcLayout` 只保留「没有 placements」这一个兜底，版本号不再参与"用不用老数据"。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步 | ✅ 全绿（见证据） |
| (a) 缺项旧数据 ⇒ 自动补齐、用户 offset/order/已设字段原样保留 | ✅ 脚本实测 JSON 片段 + 单测 |
| (b) 版本号垃圾值 / 未来值（0 / 1 / 7 / 999 / -1）⇒ 不再整份重置 | ✅ 单测 + 实机（版本 7 那类） |
| (c) 干净新装 ⇒ 与今天逐字段相同 | ✅ 单测（对齐结果 = `DEFAULTS` 逐字段）+ 实机（无持久化数据启动） |
| 幂等（连跑两次结果相同） | ✅ 单测（`alignThemeStructure` / `normalizeCcLayout` 两层）+ 实机（重启后 DOM 几何逐像素相同） |
| 既有测试不许改语义 | ✅ 仅 `ccLayoutV8.test.ts` 一条用例的**期望**按新行为改写（样本一字未动，逐条点名见「测试处置」）；其余零改动 |
| 契约快照重拍后无差异 | ✅ 仅 `generatedAt` 一行，已还原 |
| 实机（技能 `webview2-acceptance`） | ✅ 见「实机证据」 |
| 开发记录 | ✅ 本文件 |
| 三份同根待办标记关闭 | ✅ 仓外三份已加关闭说明 |
| issue #238 回写 | ✅ |

## 测试处置

- **修改 1 处（逐条点名，样本保留）**：`src/domains/cc/__tests__/ccLayoutV8.test.ts`
  用例原名「不在白名单里的版本整份回落默认布局」→ 改名「版本号是历史值/垃圾值也不再整份重置：按 id 合并并保留用户位置（#238 刀2）」。
  **样本（`{version: 2, placements: {model: {slot:'actions', order:9, offsetX:11, offsetY:-3}}}`）一字未动**，
  只把期望从「= 默认布局」改成「= 用户位置」，并新增「未提供的项仍补默认」的断言。原因：版本白名单整段退场（验收 §3-3 预期内的写法调整）。
- **新增 2 个文件 / 16 用例**：`structuralAlignment.test.ts`（12）、`themeRehydrateAlignment.test.ts`（4）。均已做反向验证。
- **未改未删**：`migration.test.ts`、`themeSchemaV8Backfill.test.ts`、`themeDefaults.test.ts`、`ccHeightState.test.ts`、`widgetDefinitionTable.test.ts` 等全部原样通过。

## 证据

- **commit**：`507090a4`（L.md）→ `27a682e7`（实现）→ `0de46d4e`（测试写法修正）
- **门禁（冻结态 `0de46d4e`，按顺序）**：

```text
$ bun run lint                  → LINT_EXIT=0（1 warning 在 RightRailHost.tsx，非本刀）
$ bun run build:example-plugin  → EP_EXIT=0
$ bun run build                 → BUILD_EXIT=0
$ bun run check:solid           → SOLID_EXIT=0
$ bun run test                  → TEST_EXIT=0；Test Files 626 passed (626)；Tests 4717 passed | 1 todo (4718)
```
对账：刀1 终点 624 文件 / 4701 通过 → 本刀 626 / 4717 = **+2 文件 / +16 用例 / 0 删除**。

- **三类构造数据（脚本实跑，`bun /tmp/d2-evidence.mjs`）**：

```text
=== (a) 缺项旧数据（只有 model 一项，用户拖过）===
BEFORE {"placementKeys":["model"],"model":{"slot":"status-secondary","order":7,"offsetX":12,"offsetY":-3},"ccHidden":["tokens"],"ccScale":{"model":120},"ccHeight":220,"modelWidth":150}
AFTER  {"placementKeys":["input","model","reasoning","mode","tokens","cc-send-button"],"model":{"slot":"status-secondary","order":7,"offsetX":12,"offsetY":-3},"reasoning":{"slot":"status-secondary","order":3,"offsetX":0,"offsetY":0},"ccHidden":["tokens"],"ccScale":{"model":120},"ccHeight":220,"modelWidth":150}

=== (b) 版本号垃圾值 999 ===
BEFORE {"version":999,"placements":{"model":{"slot":"status-secondary","order":7,"offsetX":12,"offsetY":-3}}}
AFTER  {"version":9,"placements":{"input":{...},"model":{"slot":"status-secondary","order":7,"offsetX":12,"offsetY":-3},"reasoning":{...},"mode":{...},"tokens":{...},"cc-send-button":{...}}}
   ★ 刀2 之前：整个 placements 会被替换成默认布局（用户位置丢失、不报错）

=== (b2) 版本号 7（发布过、曾被白名单漏掉）===
AFTER  model {"slot":"actions","order":9,"offsetX":11,"offsetY":-3} ⇒ 用户位置保留

=== (c) 干净新装（无持久化数据）===
DEFAULTS {"placementKeys":["input","model","reasoning","mode","tokens","cc-send-button"],"model":{...order:2},"ccHidden":[],"ccScale":{},"ccHeight":150,"modelWidth":120}
ALIGNED  {"placementKeys":["input","model","reasoning","mode","tokens","cc-send-button"],"model":{...order:2},"ccHidden":[],"ccScale":{},"ccHeight":150,"modelWidth":120}   ⇒ 逐字段相同

=== 幂等（连跑两次）=== once === twice ? true
```

- **契约快照重拍**：

```text
$ bun scripts/check-workbench-theme-contract.mts --write
$ git diff --stat -- src/renderers/solid-workbench/__fixtures__/
 …/workbench-skin-baseline.json | 2 +-        （仅 generatedAt 一行；随后 git checkout 还原，本刀不改动快照）
```

- **反向验证**（三条，均在冻结态重做，改回后复核通过）：

```text
A 读盘路径不跑对齐（merge 退回 {...current, ...persisted}）
  × 缺 reasoning 项被补齐，用户手调的 offset/order 与已设字段原样保留
  Tests 1 failed | 3 passed (4)

B 归一化拍平用户值（order 用默认值覆盖）
  × 12 条：含 ccLayoutV8 的 v6/v7/v8 三条既有回归 + 新增的「用户手调值一律保留」等
  Tests 12 failed

C 把版本白名单判定塞回去
  × 3 条：「版本号是历史值/垃圾值也不再整份重置」「版本 0 / 未来值 999 / 非数字」「走完整对齐链路同样不重置」
  Tests 3 failed | 18 passed (21)
```

- **实机证据**（技能 `.agents/skills/webview2-acceptance/SKILL.md`）：

真实数据来源：`%LOCALAPPDATA%\com.prism.desktop\EBWebView\Default\Local Storage\leveldb`（用户实际在用的一份，
外层 `version: 11`、`ccLayout.version: 9`、6 项齐全、`ccHidden: ["cc-send-button","attach"]`、`ccScale` 里还有 `ekg`/`pct` 这类历史键）。
★ 先备份再动手：`D:\pylon-acceptance\backup\{appdata-roaming,local-storage}`（139K + 98K）。

方法：**普通 `cargo build --bin pylon`**（内嵌 `dist`，窗口 URL `http://tauri.localhost/`）
+ **便携模式**（`<exe_dir>/data/` 放一份 AppData 拷贝 ⇒ 数据库/凭据隔离，绝不写用户的库；
日志确认 `portable data dir active`）⇒ **主题数据仍是真实那一份**。

```text
① 界面与改造前一致（无控件消失/错位）——把 DOM 与持久化数据逐条对齐（打开一个真实会话后）：
   slots: status-secondary → ["model","reasoning","mode","tokens"]（order 2,3,4,5 = 持久化里的 order）
   transform: 全部 ""（offset 0/0 ⇒ placementStyle 不产 transform）
   cc-send-button 不渲染 ⇐ ccHidden 里有它（7 套预设默认藏，符合预期）
   geometry: input(x=275) / model(x=299,w=120) / reasoning(x=452,w=132) / mode(x=617,w=132) / tokens(x=782,w=87)

② 控制台：本轮 reload 零 error/exception。
   ★ 三次启动另有 3 类既有噪声，已定位来源、**均与本刀无关**：
   - `pylon-skins 恢复失败 …schema revision 已变化`（`src/main.tsx`，皮肤子系统）
   - `恢复上次窗口尺寸失败 window.set_size not allowed`（`src/App.tsx`，debug 未授予该 Tauri 权限）
   - `切换 Agent失败`（后端 `source: agent`，日志原文 `Agent switch failed`，session=hermes；本机 agent 运行时不可用）

③ 排布没被拍平 + 缺项照样补齐（在真实数据上做的决定性验证：注入「缺项 + 用户手调」后重启）：
   注入：从真实 payload 删掉 placements.reasoning；model 改 order=7 / offsetX=12 / offsetY=-3
        （外层 version 仍为 11 ⇒ **与当前版本相同 ⇒ zustand 根本不调用 migrate**）
   重启后：
   - storedHash 8a3c32d9 == 注入值（5354→5282 字节），**localStorage 一字节未被改写** ⇒ 对齐不写盘
   - 渲染出的 status-secondary 顺序 = ["reasoning","mode","tokens","model"]
     ⇒ 缺项的 reasoning 被补齐（3）且 model 的 order 7 被保留（排到最后）
   - model 的 inline style = `transform: translate(12px, -3px)` ⇒ 用户 offset 原样保留
   复原：把注入前的原串写回并删除临时键 ⇒ themeHash 7a3cece2 / 5354 字节 = 注入前 **完全一致**；
        再 reload 后 DOM 几何与第 ① 步逐个相同

④ 用户数据完整性：`diff -rq` 备份 vs 现网 `%APPDATA%\com.prism.desktop`
   ⇒ 仅 `pylon-data-v1.sqlite3-shm`（SQLite 临时共享内存文件，重开即重建）不同，
     主库 `pylon-data-v1.sqlite3`、`-wal`、`pylon-master.key`、`pylon-workspaces.json`、`pylon-pet.json` 全部逐字节相同。
   主题值：应用内读到的哈希与注入前一致（见 ③）。
```

## 与 spec 的偏差

- **A. 挂钩点用 `merge` 而非单子点名的 `onRehydrateStorage`**：单子 §2.1 明确允许「`merge` / `onRehydrateStorage` / 显式调一次」三选一。
  选 `merge` 的决定性理由：它**不产生任何额外写盘**（见方案要点 2），且同样覆盖「版本号相同、migrate 不跑」这条关键路径（实机 ③ 正是这条）。
- **B. v11 的删键/改名（`REMOVED_CC_THEME_KEYS`、legacy `send` 键名）随对齐**一起**每次读盘跑**，而单子 §2.1 的分类表把它们列为「留在 migrate」。
  三点理由：① 它们是**幂等清理**（代码原注释即写「幂等」，实机 ③ 也印证重启不产生漂移）；
  ② 把 `normalizeThemeMigrationState` 再拆一层，会让 `migration.test.ts` 的 A1/键映射/ccLayout 断言**必须改语义**，
     直接违反验收 §3-3「既有测试不许改语义」；③ 按**停手条件 1 的判据**（真正"依赖版本号变了才做一次"才留下），
     唯一的候选是 v6 字体，它留着。⇒ 取舍结果：**保留它们的每次跑**，并在此点名请翻译确认。
- **C. 顺带修了一个被本刀放大成"每次读盘"的既存缺陷**（`migration.ts`）：`state.ccHidden = renameLegacyCcHiddenKeys(undefined)`
  会**新建一个值为 `undefined` 的键**，随后 `{...defaults.base, ...state}` 让它**覆盖掉默认值**（`[]`）——
  旧路径只在"老数据恰好缺这两个键"时踩到，而本刀把它放上每次读盘路径 ⇒ **干净新装也会变 undefined**（渲染侧 `[...ccHidden]` 会抛）。
  这是本刀必须修的（否则实机 ④ 的干净新装直接坏），改成"只有键存在时才赋值"。已由 (c) 用例与实机覆盖。
- **D. 环境侧（非代码偏差）**：`src-tauri/target/debug/pylon.exe` 是 `bun run tauri dev` 的产物（内嵌 `devUrl=http://localhost:1430`，
  独立运行会得到 `ERR_CONNECTION_REFUSED`），因此实机验收改用**普通 `cargo build --bin pylon`**（内嵌 `dist`）。
  为隔离数据库用了便携模式，跑完已删除 `src-tauri/target/debug/data/`。
- **E. 待办事实更正**：`已处理/中控布局版本白名单-缺7-待办.md` 描述的「`7` 不在白名单」在手术前**已不成立**
  （现文件为 `[3,4,5,6,7,8,当前版本]`，#197 已补 7）。但该待办指出的**成因**（白名单内插「当前版本」变量，每升版本自动少一项）
  正是刀2 拔掉的东西 ⇒ 仍按它自己的 §6-1「更根本的修法」关闭。

## 未解问题

1. 偏差 B（v11 清理随对齐每次跑）请翻译确认；若要严格留在 migrate，需要动 `normalizeThemeMigrationState` 的分层与既有测试写法。
2. `ccScale` 里残留的历史键（真实数据里有 `ekg` / `pct`）**本刀未清**：它不属于 `normalizeCcLayout` 的合并面，
   且属"死数据/名单收尾"范围（刀5/第③件）。实机可见它们不影响渲染。
3. 刀3（拆掉槽位层）现在**不需要再碰版本号**：读盘时 `slot` 一律不参与判定、其余原样保留，老数据自然过渡（施工单附注）。

## 并行交集

本刀触碰：`src/domains/theme/migration.ts`、`src/ccLayoutState.ts`、`src/store.ts`、
`src/domains/cc/__tests__/ccLayoutV8.test.ts`、新增两个 `src/domains/theme/__tests__/*`、`.agents/L.md`。

**未触碰**：`src/domains/cc/widgetDefinitions.ts`（刀1 产物，只读）、插件契约面 `src/plugin-runtime/cc-widget/**`、
中控渲染 `ControlCenter.solid.tsx` / `ControlCenter.css`、`src/themeFieldDefs.ts`、`src/ui-demo/`、`src/layout-sketch/`、`docs/前端接口地图.md`。
