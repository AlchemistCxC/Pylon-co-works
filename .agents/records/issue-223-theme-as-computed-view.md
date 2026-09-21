# 开发记录 · #223 预设组装 刀3 —— `theme` 退场为计算视图（拆掉终端补全）

## 元信息

- issue：[#223](https://github.com/AlchemistCxC/Pylon-co-works/issues/223)（本线共用总 issue；类型 `refactor`）
- 分支：`feat/preset-assemble.1`（上游跟踪已解、**未 push**）
- 提交范围：**代码未提交**（工作树改动）；`56c25d8a` 仅含 `.agents/L.md` 文件域声明
- 日期：2026-09-21
- 上游文档：规范 `预设修正/预设组装/00-施工规范-预设组装-v1.0.md` §3.4 / §3.7 / §7 刀3 / §9 / §10；施工单 `预设修正/预设组装/03-施工单-刀3-预设不再自带值.md`
- 前置：刀1（`cd21829d`）、刀2（`41e8f58a` / `93771fbc`）
- **前置导出（本刀后不可再导）**：`预设修正/备份/预设组装-刀3前-有效值-20260921/`
  - `global-presets-theme.json`（10 套改造前的 `theme`，md5 `4df663534288b1c2b5a2cef8c8b95862`）
  - `default-presets-theme.json`（2 套，md5 `ff00ef4c11bbaf2cc229dedaef26e7b9`）
  - `factory-zone-presets.json`（50 条工厂数据，md5 `f5849b574d63552a92d36a261c0b0972`）
  - 附 `索引.md` + 只读脚本 `dump-effective-themes.ts`

## 目标与范围

**目标**：消灭「值存两份」——10 套出厂预设不再手写 `theme`，有效值改由区域引用表 + 工厂数据**算出来**；
连同整块拆掉「终端补全」这套机制。

**不做什么**（施工单 §2.6，逐条守住）：

- ❌ **不做数据瘦身**（工厂数据 `src/zones/factory/**` 一个字节未动 —— A3 验过）
- ❌ 不去重、不动 `terminal-cc.ts`(709 行) / `terminal-chat.ts`(454 行) 的拆分
- ❌ 不改 UI 观感、不改 `applyGlobalPreset` 对外签名、不 bump 版本号
- ❌ 不动自定义预设（`customPresets` / v2 包 / `saveZonePresetEntry`）
- ❌ 不碰禁区三项（`src/ui-demo/`、`src/layout-sketch/`、`docs/前端接口地图.md`）

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| **新增** `src/zones/effectivePresetTheme.ts` | 有效值视图（纯函数，62 行） | 新增 |
| `src/presets/builtin.ts` | 10 套摘掉手写 `theme`（−606 行）；`GLOBAL_PRESETS` 去掉补全投影；两条默认预设的 `theme` 改**字面量快照**；`DEFAULT_PRESETS` 收紧为 `DefaultPreset`（theme 必填）；删死函数 `requireGlobalPreset` | 修改 |
| `src/presets/types.ts` | `GlobalPreset.theme` 改**可选** | 修改 |
| `src/presets/completion.ts` | **整文件删除**（`TERMINAL_COMPLETION` / `TERMINAL_VISUAL_COMPLETION` / `completeTerminalPreset`） | 删除 |
| `src/presets/index.ts` | 去掉 `export * from './completion.ts'`（删除的必然连带） | 修改 |
| `src/application/transactions/applyGlobalPreset.ts` | `planGlobalPreset` 用视图算有效值，token 叠在其上（回落分支因此不再被 10 套走到） | 修改 |
| `src/domains/workbench/workbenchSkinContract.ts` | 夹具主题来源改视图（**`:220` 与 `:188` 两处**，见「与 spec 的偏差 2」） | 修改 |
| `src/components/settings/TemplateLibrary.tsx` | 官方段：有效值**只算一次**，显示用主题与 `createPresetBundle` 的主题两处共用 | 修改 |
| `src/zones/zonePresetPool.ts` | 删刀2 的两个参考实现（`deriveZonePresetPool` / `deriveFactoryZonePresetEntries`）+ 连带清理（`GLOBAL_PRESETS` / `GlobalPreset` / `pickZoneFields` 三个不再使用的 import） | 修改 |
| `src/zones/index.ts` | 转出有效值视图与新类型；去掉两个 `derive*` | 修改 |
| **删** `scripts/generate-factory-zone-presets.mts` | 刀2 过渡护栏（其输入＝预设自带的 `theme`，已消失） | 删除 |
| **新增** `src/__tests__/effectivePresetTheme.test.ts` | B1–B5（10 用例） | 新增 |
| 测试（§4.3 授权清单） | 逐条点名见下 | 修改 |
| **删** `src/__tests__/completeTerminalPreset.test.ts` | 被删机制的测试（3 用例） | 删除 |

规模：已跟踪文件 **+238 / −1124**（−606 是 builtin.ts 摘掉的手写 theme）；新增 2 个文件共 236 行。

## 方案要点

### 1. 有效值视图放在 `src/zones/effectivePresetTheme.ts`，**不 import `presets/` 的运行时导出**

- 语义：写了 `theme`（两条默认预设）⇒ 直接用；只写 `zoneRefs`（10 套）⇒ 5 个区域工厂数据切片之并集。
- ★ **为什么不放在 `presets/`**：`zones/zonePresetPool.ts` 反过来 import `presets/` 的桶表（`INTERFACE_MODE_PRESET_BUCKET`），
  反向的**运行时**依赖会成模块环。所以视图落在 `zones/`，入参是**调用方传进来的预设对象**（结构性类型
  `ZoneRefBackedPreset`），只做 `PresetInterfaceMode` / `ZoneRefMap` / `ThemeSettings` 几个**类型**进口（`import type` 类型擦除）。
- **`bun run build` 通过 = 无环**（`tsc -b` + vite 全绿；报告里贴了输出）。
- 零变化的依据：刀1 证「装配结果 == 旧路径 patch」、刀2 证「工厂数据 == `pickZoneFields(preset.theme, zone)` 逐字段」
  ⇒ 五片并集 == 原 `theme`。**前提（本刀头号坑）开工第一步已实测**：191 = 17+8+78+83+5、`layout` 0 字段、
  逐套「`theme` 键集 vs 五区并集键集」**完全相等**（会丢 0、多出 0）⇒ 没有任何键会因切分而丢失。

### 2. 四条生产读点（逐个接上视图）

`planGlobalPreset`（含呈现方案 token 叠加）· 夹具 `builtin-*`/`mixed-zones` · TemplateLibrary 官方段两处 ·
`effectivePresetTheme` 本身即唯一出口。`applyGlobalPreset` 的对外签名与返回值一字未变。

### 3. 两条默认预设的值：字面量快照（**本刀唯一需要你确认的设计选择**）

原先它们靠 `requireGlobalPreset('glass').theme` —— 一个指向 glass `theme` 对象的**引用**。刀3 摘掉 glass 的 `theme` 后，
`presets/` 又不能 import `zones/`（环）⇒ 只剩两条路：① 落成字面量快照；② 把 `DEFAULT_PRESETS` 搬家到能算的地方。
选 ①，理由：**刀1 已裁定这两条按定义就是 glass 的"拷贝"而非引用**（原话「终端默认是 `glass` 的**拷贝**……
用引用表达错了语义」），所以各自持有一份自己的值是正确的表达；且 ① 不需要搬家（否则触发施工单 §八-6）。
漂移由测试钉住：`DefaultPreset`（类型上把 `theme` 收回必填）+ `effectivePresetTheme.test.ts` 的 B3。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| A1 契约夹具除时间戳外逐字节不变（★ 主证据） | ✅ `--numstat` **1 增 1 删**（仅 `generatedAt`）；第 3 行起 `diff` 无输出、5348/5348；验完 `git checkout --` 还原。**它逐条覆盖 10 套预设的有效值**（夹具就是 `mergeTheme(effectivePresetTheme(preset))`） |
| A2 全量测试 | ✅ 617→**617** files、4563→**4570** passed、failed **0**、todo 1。**逐项归因**：−1 文件 −3 用例（删 `completeTerminalPreset.test.ts`）+ 1 文件 +10 用例（新增 B1–B5）⇒ 净值 0 文件 / +7 用例 |
| A3 工厂数据零改动 | ✅ `git status --porcelain src/zones/factory/` 为空 |
| B1 有效值等价 | ✅ 10 套逐套：视图 == 测试侧**独立算法**算出的五区并集（键集 + 逐字段）；**另与仓外导出对拍**：10 套 + 2 套默认逐字段相同 |
| B2 键集完整 | ✅ 静态不变量（191 = Σ五区、`layout` 0 字段、无重复归属、`.`zone` 必属已知区域）+ 逐套键数对基线（191/69/191/…/36，不抽样）+ 视图逐区覆盖该区全部键 |
| B3 两条默认预设走直给 | ✅ 视图对默认预设 == 它自己写的 `theme`；10 套一律带引用表（回落分支不再被走到）；`planGlobalPreset` 的有效值 == 视图（token 叠其上） |
| B4 补全机制没了 | ✅ **源码级扫描**（`src/` + `scripts/`，含测试）零命中；`completion.ts` 不存在。（`.agents/` 历史文档仍会提到它——见「未解问题 1」） |
| B5 模板库两处同源 | ✅ 源码断言：官方段无 `preset.theme`、`effectivePresetTheme(` **只出现 1 次**、显示用主题与落盘包由**同一个局部变量**喂 |
| 门禁 7 条（去掉已删的生成脚本） | ✅ 全绿（见下） |

## 测试处置（§4.3 逐条点名）

**删除**：`src/__tests__/completeTerminalPreset.test.ts`（整文件，3 用例 —— 被删机制的测试）。

**只换「值的来源」、断言语义不变**（`preset.theme` / `GLASS.theme` → `effectivePresetTheme(...)`；`deriveZonePresetPool(...)` → `assembleFactoryZonePresetPool(手写条目)`）：

| 文件 | 改动行 | 改了什么 |
| --- | --- | --- |
| `src/__tests__/presets.test.ts` | +2/−2 | `pickZoneFields(preset.theme,'cc')` → 视图 |
| `src/__tests__/defaultPresets.test.ts` | +11/−9 | 5 处取值改视图；**2 处必须改的理由特殊**：`:84` 的 `toBe(GLASS.theme)` → `toEqual(视图)`（glass 不再有 theme 对象，"同一个对象"这个说法失去了指称，改为"同一份值"）；`:197` 的"重置不写出厂预设内容"守卫**两侧同时**改视图（否则两边都是 `undefined[]`，那条守卫会变成永远绿 —— 这是防"假测试"的必要改动，不是放宽） |
| `src/domains/theme/__tests__/titlebarTheme.test.ts` | +3/−2 | 2 处读 titlebar 字段改视图 |
| `src/domains/theme/__tests__/terminalPresets.test.ts` | +5/−4 | 4 处读字段改视图 |
| `src/domains/theme/__tests__/migration.test.ts` | +2/−1 | 1 处 `preset.theme as Record<string,unknown>` → 视图（**必须改**：不改则 `undefined` 上跑 `toHaveProperty` 会抛） |
| `src/domains/workbench/__tests__/appearance.test.ts` | +2/−1 | 1 处读 `globalFont` 改视图 |
| `src/zones/__tests__/zonePresetPool.test.ts` | +12/−11 | 「不折叠」夹具由 `deriveZonePresetPool(预设数组)` 改为 `assembleFactoryZonePresetPool(手写条目)`（刀2 参考实现已删）；「出厂条目应用切片」的参考值改视图 |
| `src/zones/__tests__/factoryZonePresets.test.ts` | +20/−17 | 同上两处夹具改造；B1/B4 的参考值改视图；B1 标题随之更名（见「与 spec 的偏差 3」） |

**★ 超出 §4.3 清单、但被类型变更逼出来的 2 个文件（§4.4 回归清单里点名"一行不改"的那两个）**：

| 文件 | 改动行 | 为什么躲不掉 | 语义等价性 |
| --- | --- | --- | --- |
| `src/__tests__/presetAssembly.test.ts` | +13/−13 | `GlobalPreset.theme` 改成可选后，该文件 10 处直接读 `preset.theme` **编译不过**（TS18048 / TS2345）。§4.4 与 §2.1「类型上改成可选」在本仓的代码现实里互斥 | 全部是 `preset.theme` → `effectivePresetTheme(preset)` 的**读值路径**替换；刀3 的核心主张就是"视图 ≡ 旧 theme"（A1 夹具 + 外部导出双双逐字节证明），故断言在语义上**逐字未变**（20 条用例仍全绿，且它们正是刀1 的装配等价性断言） |
| `src/domains/theme/__tests__/presetReducer.test.ts` | +6/−5 | 同上（5 处 `nord.theme` / `glass.theme` / `solarized.theme`） | 同上；另**只改了一行注释**里被删机制的名字（B4 要求零命中） |

**未改**：`applyGlobalPreset.test.ts`、`themeDefaults.test.ts`、`customPresetApply.test.ts`、`customPresetOverwrite.test.ts`、`workbenchSkinContract.test.ts`（无一字改动，全绿）。

## 证据

- **门禁**：
  - `bun run lint` → 0 errors（1 个既有 warning 在 `RightRailHost.tsx`）
  - `bun run build:example-plugin` → `dist/entry.js + dist/styles.css + dist/entry.d.ts 已由 src/ 重建`
  - `bun run build` → `tsc -b` 无错（**同时证明无 import 环**）；`✓ built in 11.22s`
  - `bun run check:solid` → 全子门禁通过（含 `ZONE_FIELDS 一致性契约通过（191 个主题字段）`）
  - `bun run test` → `Test Files 617 passed (617)` / `Tests 4570 passed | 1 todo (4571)`，`TEST_EXIT=0`
  - `bun scripts/check-theme-field-consistency.mts` → 通过（191 字段）
  - `bun scripts/check-workbench-theme-contract.mts --write` → 见 A1（1 增 1 删仅时间戳，已还原）
  - （`scripts/generate-factory-zone-presets.mts` 本刀已删 ⇒ 门禁里不再有它）
- **外部基线对拍**（独立于活视图，读刀3 前的导出）：`10 套 + 2 套默认预设有效值逐字段零变化 ✅`

### 反向验证（R1–R5，改坏 → 变红 → 改回；无残留）

| # | 改坏什么 | 结果 |
| --- | --- | --- |
| R1 | 视图漏并一个区域（跳过 `right`） | **B1 红**：`claude 键集: expected [186 keys] to deeply equal [191 keys]`；**B2 红**：`claude 键数: expected 186 to be 191`；**A1 夹具 15/15 行差异**（不是只有时间戳） |
| R2 | 视图改成"先铺默认值" | **B1 两条都红**：`claude 键集: 191 vs 190` + 并点名多出的键 `ccEditMode`。★ **A1 夹具仍只差 1/1（时间戳）** —— 夹具走 `mergeTheme({...DEFAULTS, ...delta})`，铺默认值在那里天然不可见 ⇒ 这条差异只有 B1 能守（如实记录，未硬凑） |
| R3 | TemplateLibrary 只改一处（显示用新、bundle 用旧） | **B5 红**：`官方段不得再读 preset.theme（那会让两处不一致）` |
| R4 | 把 `completion.ts` 恢复回来（机制复活） | **B4 红**：点名 3 处命中（`src/presets/completion.ts ← completeTerminalPreset / TERMINAL_COMPLETION / TERMINAL_VISUAL_COMPLETION`）；删回即绿 |
| R5 | 往工厂数据里改一个值（模拟"顺手瘦身"） | **A3 红**：`git status` 出现 `M src/zones/factory/gui-right.ts`（1/1）；**A1 夹具 3/3 行差异** |

改回后 `grep -rn "★R[1-5] 反向验证" src/ scripts/` **无残留**；`git status` 里 `src/zones/factory/` 为空。

## 与 spec 的偏差

1. **两条默认预设的 `theme` 从"引用 glass 的 theme 对象"改为字面量快照**（见「方案要点 3」）。施工单 §2.1 只说"两条默认预设仍写它"，没写值从哪来；实测发现原来源（`requireGlobalPreset('glass').theme`）在本刀后不存在，而 `presets/` → `zones/` 会成环。选"字面量"而非"搬家"，因为刀1 已裁定它们是 glass 的**拷贝**、且搬家会触发 §八-6。
2. **夹具的读点比施工单 §2.3 表多一处**：该表只列 `:220`（`builtin-*` 夹具），但同文件 `:188` 的 `createMixedTheme` 也读 `preset.theme`（glass/tokyo/amber 三套）——只改一处会让 `mixed-zones` 夹具失配、A1 必红。两处同改（都在 `workbenchSkinContract.ts` 这个本刀文件域内）。
3. **刀2 的 B1 断言被重新瞄准**（`factoryZonePresets.test.ts`）：原为"数据 == 现场派生参考（`pickZoneFields(preset.theme, zone)`）"。刀3 删掉派生后，若只把参考值换成视图，那条断言会退化成"同一份数据自己比自己"（切片→并集→再切回，恒真）。改为锁**往返无损**并保留原有强度可用的一半，同时把"值 == 改造前"的举证责任交给 **A1 夹具**（逐字节）与**外部导出对拍**（逐字段）。这是一次**断言重瞄**（不是放宽：新断言在 R1 下同样红，而旧的"数据==派生"已无指称对象）。
4. **`DefaultPreset` 类型**（新增，`builtin.ts` 内）：把两条默认预设的 `theme` 收回必填。**这是为了不动 `src/store.ts`**——`store.resetTheme` 读 `target.theme`，若 `theme` 只可选，那里就得写 `?? {}`（会把默认预设的值悄悄清空 = 行为变化）或改 `store.ts`（不在本刀文件清单内）。用类型收窄既守住不变量、又零外溢。
5. **`origin` 之外的连带清理**：`src/presets/index.ts` 去掉 `completion.ts` 的转出（删除文件的必然连带）；`zonePresetPool.ts` 顺手清掉三个因删 `derive*` 而失效的 import（`减重`，无行为影响）。

## 未解问题

1. **`.agents/` 历史文档仍提到被删机制**（L.md 的刀3 声明必须点名待删文件；`records/` 是留档）。B4 的扫描范围定为 `src/` + `scripts/`（**代码与测试**），未把 `.agents/` 算进去——改历史留档等于篡改记录（`AGENTS.md` §4 不改写历史）。若你要"全仓字面零命中"，需要在单子里明确"历史文档怎么写"。
2. **10 个工厂数据文件的抬头仍指向已删的生成脚本**（"本文件由 `scripts/generate-factory-zone-presets.mts --write` 生成"）。修它要动 `src/zones/factory/**`，而 A3 硬要求该目录**一字节不动** ⇒ 本刀保留，留作将来（与"认真去重"那次一并处理）。
3. **`pickZoneFields` 现在只剩测试在用**（生产路径不再需要"现场切"）。刀3 未删它——刀1 的 `presetAssembly.test.ts`（§4.4 回归清单）与两个 zone 测试仍以它为参考实现。要不要降级/内联，留给将来。
4. **`planGlobalPreset` 的"无引用表回落整份 theme"分支**：10 套全带引用表后，该分支在出厂预设上已不可达（仅对"将来可能出现的无引用表预设"有意义）。保留是施工单 §2.3-1 的要求，但它是**当前无生产触达的分支**。

## 并行交集

本次碰过的共享文件（供其他贡献者避让）：

- `src/presets/**`（`builtin.ts` 结构性改动：摘 theme、去补全投影、默认预设改字面量；`types.ts` theme 改可选；**删 `completion.ts`**；`index.ts` 去转出）
- `src/zones/effectivePresetTheme.ts`（**新增**）、`src/zones/zonePresetPool.ts`、`src/zones/index.ts`
- `src/application/transactions/applyGlobalPreset.ts`
- `src/domains/workbench/workbenchSkinContract.ts`（夹具两处）
- `src/components/settings/TemplateLibrary.tsx`（官方段两处）
- 测试：新增 `src/__tests__/effectivePresetTheme.test.ts`；删除 `src/__tests__/completeTerminalPreset.test.ts`；修改 8 个既有测试（见「测试处置」）
- **删** `scripts/generate-factory-zone-presets.mts`
- `.agents/L.md`（文件域声明，已单独提交 `56c25d8a`）

未声明、也未触碰：`src/zones/factory/**`（**一字节未动**）、`src/store.ts`、`src/domains/theme/presetReducer.ts`、`src/themeFieldDefs.ts`、`src/zones/pickZoneFields.ts`、`package.json`、契约快照 JSON、`docs/**`、`src/renderers/**`、`src-tauri/**`、`tools/**`。
