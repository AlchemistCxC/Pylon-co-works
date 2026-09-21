# 开发记录 · #223 预设组装 刀2 —— 出厂区域预设独立成数据

## 元信息

- issue：[#223](https://github.com/AlchemistCxC/Pylon-co-works/issues/223)（本线**共用总 issue**，各刀不另开；类型 `refactor`）
- 分支：`feat/preset-assemble.1`（刀1 已在此分支；上游跟踪已解、**未 push**）
- 提交范围：**代码未提交**（工作树改动）；`68908c0e` 仅含 `.agents/L.md` 文件域声明
- 日期：2026-09-21
- 上游文档：规范 `预设修正/预设组装/00-施工规范-预设组装-v1.0.md` §7 刀2（含「★ 裁决 A：不折叠」「★ 陷阱 B」）；施工单 `预设修正/预设组装/02-施工单-刀2-出厂区域预设独立成数据.md`
- 基线备份（**本刀 A1 的对拍来源**）：`预设修正/备份/预设组装-前存档-20260921/`
  - `global-presets.json`（10 套全量值，md5 `75ed15819986e33cc30536d49ba47a44`）
  - `zone-slices.json`（50 条出厂区域切面，md5 `c8a45cc4824b81c967d6d767c5d717c2`）
  - 第 3 项（实机 `pylon-theme` 样本）**未取到**，原因见「未解问题」
- 前置关卡：刀1 已完成并落存档（`cd21829d`）；刀1 开发记录 `.agents/records/issue-223-preset-zone-refs-assembly.md`

## 目标与范围

**目标**：把 **50 条**出厂区域预设从「构建时派生」改成**落盘数据**——每条有自己的身份与自己的值，
`ZONE_PRESET_POOL` 的数据来源换成这份数据表，让区域预设真正成为「独立的一块」。

**不做什么**（施工单 §2.5，逐条守住）：

- ❌ **不做数据瘦身**（终端 6 套的切面照抄全量 191 字段的分布；刨掉补全层是刀3 的行为变更）
- ❌ 不删任何数据、不做去重（"认真去重"是将来另一次）
- ❌ 不动 `src/application/transactions/applyGlobalPreset.ts`（刀1 的引用解析已能读新池）
- ❌ 不动 `zonePresetsFor` / `resolveZonePresetEntryTheme` 的**签名**
- ❌ 不改自定义预设那条路（`customPresets` / v2 包 / `saveZonePresetEntry` 的语义）
- ❌ 不动 `Settings.tsx` 的观感（只删了同形悬停提示那一处 + 同步注释）
- ❌ 不 bump `THEME_SCHEMA_VERSION`（仍 11）/ `CC_LAYOUT_SCHEMA_VERSION`（仍 9）
- ❌ 不碰 `src/ui-demo/`、`src/layout-sketch/`、`docs/前端接口地图.md`（禁区，已在 `.git/info/exclude` 内）

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/zones/zonePresetPool.ts` | 条目形状（`origin` + 必填 `values`，`sources` 退场）；判据换源；`resolveZonePresetEntryTheme` 直取 `values`；`deriveZonePresetPool` 去折叠退为参考实现；新增 `assembleFactoryZonePresetPool`；`ZONE_PRESET_POOL` 改读数据表 | 修改 (+100/−76) |
| `src/zones/index.ts` | 门面转出补 `FACTORY_ZONE_PRESET_ENTRIES` / `assembleFactoryZonePresetPool` / `deriveFactoryZonePresetEntries` / `ZonePresetOrigin` | 修改 (+4/−1) |
| `src/components/Settings.tsx` | 删除 `entry.sources` 同形悬停提示（`title` 分支）；注释同步为 `origin` 判据 | 修改 (+3/−4) |
| `src/zones/__tests__/zonePresetPool.test.ts` | **只改「判据 / 折叠」直接相关的那两条断言**（见「测试处置」） | 修改 (+12/−16) |
| `src/zones/factory/**`（11 个文件） | **新增**：10 个数据文件（2 桶 × 5 区域，2279 行）+ 手写索引 `index.ts` | 新增 |
| `scripts/generate-factory-zone-presets.mts` | **新增**：默认校验 / `--write` 产出；越区键报错 + 活数据源护栏 | 新增 (+189) |
| `src/zones/__tests__/factoryZonePresets.test.ts` | **新增**：B1–B6（13 用例） | 新增 (+233) |

## 方案要点

### 1. 只换「池的数据来源」（施工单 §2.3 的关键）

`zonePresetsFor` 与刀1 的 `expandGlobalPresetZoneRefs` **都读 `ZONE_PRESET_POOL`** ⇒ 只把
`ZONE_PRESET_POOL` 的来源从 `deriveZonePresetPool(GLOBAL_PRESETS)` 换成
`assembleFactoryZonePresetPool(FACTORY_ZONE_PRESET_ENTRIES)`，**这两个消费方一行未改**。

★ 附带一条可被机器钉住的后果：`assembleFactoryZonePresetPool` **把数据文件里的对象本身放进池**（不复制、不重算），
于是「数据表是活数据源」有了直接判据（B1 的同一性断言 + 生成脚本的活数据源护栏）。

### 2. ★ 陷阱 B：出厂条目带上值以后，判据必须换轴

`isCustomZonePresetEntry` 原判据是 `entry.values !== undefined`，而刀2 起出厂条目**也带 `values`**
⇒ 出厂条目会变成「可删」、UI 亮「自定义」、删除闸门（`removeZonePresetEntryReducer` 依赖"出厂条目从不进
`zonePresetEntries`"）也挡不住。现判据：

```ts
export function isCustomZonePresetEntry(entry: ZonePresetEntry): boolean {
  return entry.origin !== 'factory'   // 缺省（无 origin）= 自定义：持久化通道只存用户条目
}
```

消费点逐个跟改：判据本体、门面转出（名字不变）、UI 的 `deletable`（表达式不变，语义由新判据承担）、
UI 同形悬停提示（**随折叠一起删除**）。**R2 反向验证**证明这条轴是真闸门：把判据改回
`values !== undefined`，50 条出厂条目一律被判为自定义、UI 上出厂 chip 选中时**冒出删除按钮**。

### 3. ★ 裁决 A：折叠退场（刀1 引用表与折叠互斥）

刀1 的 `zoneRefs` 是逐套显式写自己的名字；折叠会把内容相同的多条并成一条、只留排序最前的 id
⇒ 被折叠那套装不上（引用解析抛错）。刀2 去掉折叠、`sources` 字段退场，
`deriveZonePresetPool` 退为**参考实现**（生成脚本 + 测试对拍用），不再进生产读路径。
当前实测每格恰好 5 条、无一折叠 ⇒ **行为零变化**。

★ 附带效果：生产路径**结构上不可能再折叠**（池的来源是数据表，不是派生）——这一点由
B1 的同一性断言与 B6 的「每格 id 恰好等于桶内预设名」共同锁住。

### 4. 生成脚本（过渡期护栏）

`scripts/generate-factory-zone-presets.mts`：默认**校验**（现场派生 → 规范化文本 → 与数据文件**逐字节**比对，
不一致打印「第几行 + 期望/实际」并以 1 退出）、`--write` 才写盘。两条额外护栏：

- **越区键报错**：调用与生产池同一个 `assembleFactoryZonePresetPool`（内含刀1 的 `assertZoneSliceOwnership`，
  判据 `ZONE_FIELDS`）——越区键**抛错，不静默丢弃**；
- **活数据源**：断言生产的 `ZONE_PRESET_POOL` 逐条引用 `FACTORY_ZONE_PRESET_ENTRIES` 里的**那些对象**
  ⇒ 池若退回现场派生，脚本立刻以「数据文件成了死数据」退出 1（R5 验证过）。

★ **退出条件：刀3 落地后删除本脚本**（那时预设不再自带 `theme`，本脚本的输入消失），
并连带清理 `deriveZonePresetPool` / `deriveFactoryZonePresetEntries` 两个参考实现。
这条已写在脚本抬头，避免留成死工具。

### 5. 数据文件组织与实测行数

按 **(桶, 区域) 拆 10 个**（施工单 §2.1 的备选方案）。选它的依据是实测超阈：

| 文件 | 条数 | 字段值 | 行数 | | 文件 | 条数 | 字段值 | 行数 |
|---|---|---|---|---|---|---|---|---|
| `gui-global.ts` | 5 | 52 | 116 | | `terminal-global.ts` | 5 | 85 | 149 |
| `gui-sidebar.ts` | 5 | 21 | 85 | | `terminal-sidebar.ts` | 5 | 40 | 104 |
| `gui-chat.ts` | 5 | 163 | 227 | | `terminal-chat.ts` | 5 | 390 | **454** |
| `gui-cc.ts` | 5 | 122 | 238 | | `terminal-cc.ts` | 5 | 415 | **709** |
| `gui-right.ts` | 5 | 10 | 74 | | `terminal-right.ts` | 5 | 25 | 89 |

若按「5 个文件（每区域含两桶）」组织，`chat.ts` 与 `cc.ts` 会到 ~680 / ~947 行，**双双远超 ~400 行阈**；
10 路拆分后仍有两个文件超阈（`terminal-chat` 454、`terminal-cc` 709）。**施工单只授权 5 路或 10 路两种组织方式**，
故未再按条目细分。`terminal-cc` 偏大的原因是结构性的：cc 区的 `ccLayout` 是个嵌套对象，
5 份展开就占 ~250 行（415 个字段值里只有 3 个是它/`ccHidden`/`ccScale`）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| A1 逐字段相等 | ✅ 50 条 × 全部字段与「该刻派生结果」逐字段相等（B1，`toEqual` 非抽样）；**另与外部备份存档对拍**：50 条切面 + 10 套预设 `theme` 逐字段零变化 |
| A2 生成可复现 | ✅ 默认校验模式绿（`EXIT=0`）：落盘数据与现场派生**逐字节一致** |
| A3 全量测试既有部分同数同结果 | ✅ 616→**617** files、4550→**4563** passed、failed **0**、todo 1；增量恰好 = 新测试文件（+1 文件 / +13 用例） |
| A4 契约快照除 `generatedAt` 外逐字节相同 | ✅ `--numstat` 1 增 1 删（仅 `generatedAt`）；第 3 行起 `diff` 无输出、5348/5348；验完已 `git checkout --` 还原 |
| B1 数据 == 派生参考 | ✅ 50 条逐条 `toEqual`；池条目 = 数据表同一对象；每格条数/顺序 = 桶内预设 |
| B2 出厂条目不可删 | ✅ 50 条判据一律非自定义；删除 reducer 传出厂名是 no-op；UI 选中出厂 chip 无删除入口；自定义条目仍判自定义 |
| B3 出厂条目不进 `zonePresetEntries` | ✅ 存/删自定义条目全流程三个检查点，10 个出厂 id 均未混入 |
| B4 引用解析仍通 | ✅ 10 套 × 5 区域全部解析，值 = 派生切片，且**就是数据里的那份 `values`**（`toBe` 同一性） |
| B5 越区键报错 | ✅ 真实数据装配不报错；往 cc 塞 `sidebarBg` ⇒ 构造期抛错并报出键名 |
| B6 无折叠 | ✅ 每格 id 恰好等于桶内预设名、池里无 `sources`；合成两块同形仍各留一条 |
| 门禁 7 条 | ✅ 全绿（见下） |

## 测试处置

**新增**：`src/zones/__tests__/factoryZonePresets.test.ts`（13 用例，B1–B6）。

**修改既有测试：只有 `src/zones/__tests__/zonePresetPool.test.ts` 的两条**（施工单 §4.3 授权的"判据 / 折叠直接相关"范围，改动集中在 `:61-96`，`git diff -U0` 的 hunk 全部落在该区间）：

1. **`:61-78`「每格条数…覆盖该桶全部预设」**：断言从
   `entries.flatMap(e => [e.id, ...(e.sources ?? [])])` 改为 `entries.map(e => e.id)`
   （`sources` 字段已退场；不折叠后每套预设各留自己那条，id 集合本就等于桶内全部预设名），并同步标题措辞。
   **同时删除**其中「同一格内不得有同形重复条目」那一条——它与裁决 A 的"同形也各留一条"**直接冲突**，
   留着会在两块同形出现时误报。
2. **`:80-96`「去重：同形切面折叠为一条…」→ 改写为「不折叠」**：同一份合成夹具（两套同形 + 一套不同形），
   期望从「2 条、sources 记折叠来源」翻转为「**3 条、各自 id/label 取自己的来源、无 `sources`**」。
   这是裁决 A 的**契约变更**，不是"改口径"。

**未改任何其它既有测试**：`presetAssembly.test.ts`（刀1 的 20 条）一行未动、保持绿；
`defaultPresets.test.ts`、`presets.test.ts`、`presetReducer.test.ts`、`applyGlobalPreset.test.ts`、
`themeDefaults.test.ts` 全部一行未动。

## 证据

- **门禁**（顺序未跳）：
  - `bun run lint` → 0 errors（1 个既有 warning 在 `RightRailHost.tsx`，非本刀文件）；`scripts/` 新脚本单独 eslint 亦 0
  - `bun run build:example-plugin` → `dist/entry.js + dist/styles.css + dist/entry.d.ts 已由 src/ 重建`
  - `bun run build` → `tsc -b` 无错；`✓ built in 12.09s`
  - `bun run check:solid` → 全子门禁通过（含 `ZONE_FIELDS 一致性契约通过（191 个主题字段）`、CSS 消费审计、工作台皮肤 contract）
  - `bun run test` → `Test Files 617 passed (617)` / `Tests 4563 passed | 1 todo (4564)`，`TEST_EXIT=0`
  - `bun scripts/check-theme-field-consistency.mts` → 通过（191 字段）
  - `bun scripts/generate-factory-zone-presets.mts` → `GEN_EXIT=0`「落盘数据与现场派生逐字节一致」
  - `bun scripts/check-workbench-theme-contract.mts --write` → 见 A4（1 增 1 删仅时间戳，已还原）
- **A1 外部基线对拍**（独立于活参考实现，读备份存档 JSON）：
  `已对拍 50 条（备份记 50 条）` / `已对拍 10 套` / `A1 结论：与备份存档逐字段零变化 ✅`
- **改动规模**：已跟踪文件 `+119/−97`（`zonePresetPool.ts` +100/−76、`index.ts` +4/−1、`Settings.tsx` +3/−4、`zonePresetPool.test.ts` +12/−16）；新增 13 个文件合计 2701 行
- **未动的面**（`git status` 为空验证）：`applyGlobalPreset.ts`、`presetReducer.ts`、`presets/**`、`store.ts`、`themeFieldDefs.ts`、`pickZoneFields.ts`、`package.json`、契约快照 JSON、`docs/**`

### 反向验证（R1–R5，改坏 → 变红 → 改回；无残留）

| # | 改坏什么 | 结果 |
| --- | --- | --- |
| R1 | `gui-right.ts` 的 `rightWidth: 250 → 251` | **B1 红**：`gui/right/glass 全部字段: expected {rightWidth: 251} to deeply equal {rightWidth: 250}`；**生成脚本校验同红**：`gui-right.ts：与现场派生不一致（第 21 行起）`，退出码 1 |
| R2 | 判据改回 `values !== undefined` | **B2 红**：50 条出厂条目判据 `expected false to be true`；UI「出厂 chip 被选中也不出删除入口」`expected [Array(1)] to have a length of +0 but got 1` |
| R3 | 摘掉装配层的越区校验 | **B5 红**：`expect(() => assembleFactoryZonePresetPool([poisoned])).toThrow(/越区/)` → `expected [Function] to throw an error` |
| R4 | 把折叠放回 `deriveZonePresetPool` | **B6 红**：合成双胞胎 `expected [1 entry] to have a length of 2 but got 1`；`zonePresetPool.test.ts` 改写后的「不折叠」同红（`expected 2 to be 3`）。★ **生产池那条仍绿**——池的来源已是数据表，折叠**无法**从参考实现侧回到生产路径（这正是裁决 A 的结构性保证） |
| R5 | `ZONE_PRESET_POOL` 退回 `deriveZonePresetPool(GLOBAL_PRESETS)` | **A2 红**：脚本以 1 退出并报 `生产池没有消费落盘数据表（50 条不在 FACTORY_ZONE_PRESET_ENTRIES 里…）—— 数据文件成了死数据`；**B1 红**：`gui/global/glass 必须是数据表里的同一对象` |

改回后 `grep -rn "★R[1-5] 反向验证" src/ scripts/` **无残留**，两个测试文件恢复 32/32 绿、脚本 `EXIT=0`。

## 与 spec 的偏差

1. **`origin` 是可选字段（不是必填），且判据写成 `origin !== 'factory'`**。原因：`ZonePresetEntry` 还被
   **store 的 `saveZonePresetEntry`（`src/store.ts`，不在本刀文件清单内）** 与若干测试字面量直接构造；
   若把 `origin` 设为必填，就必须改 `src/store.ts` 与 4 处既有测试字面量 —— 两者都超出施工单授权的改动面。
   现设计把「显式来源」落在**数据与池的入口**：出厂数据必写 `origin: 'factory'`，池在物化持久化条目时
   显式补 `origin: 'custom'`；判据于是完全不看 `values`（陷阱 B 关闭，R2 已证），
   而历史持久化条目（无 `origin`）与调用方直造条目按自定义处理——语义与刀2 之前一致。
2. **`source: { presetName }` 保留在出厂条目上**（施工单 §2.2 写的是 `source` / `sources`「随之退场」）。
   保留 `source` 的理由：既有断言 `zonePresetPool.test.ts:111-121`（刀1 单子里被点为「本改造最关键的既有断言」）
   用 `entry.source?.presetName` 定位来源预设；删掉该字段就会连带改一条**不在**施工单授权清单里的断言。
   保留它成本极低（一条可追溯元数据，且 id 本就等于来源预设名），收益是那批断言一行不动。`sources` 已按单删除。
3. **A3 的口径**：施工单同时要求「只允许新增测试」，故 files/passed 必有增量。按「既有部分完全相同、
   增量恰好 = 新测试」验收（+1 文件 / +13 用例 / failed 与 todo 不变），已逐项对上号。
4. **R4 的期望需要一处收窄**：施工单写「把折叠逻辑放回去 ⇒ B6 必须红（两块合成一条 ⇒ 另一套引用解析失败）」。
   实际生产池已不读派生结果，折叠放回参考实现**只影响参考实现**；被折叠那套"引用解析失败"这一症状，
   在本刀结构下已由 R5（池退回派生）覆盖。B6 的红如实落在参考实现与「池里不许有 `sources`」两条上。
5. **生成脚本多了一条施工单未点名的护栏**（活数据源：池必须引用数据表对象）。加它的直接动机是让
   R5 能如施工单预期那样把 A2 打红——否则"数据文件成了死数据"只有测试能发现，护栏脚本看不见。

## 未解问题

1. **备份第 3 项（实机 `pylon-theme` 的 localStorage 样本）未取到**。已做的尝试与结论：
   ① 本机有运行中的 Pylon（`msedgewebview2.exe` 多进程），但 **WebView2 调试端点不可达**
   （`http://127.0.0.1:9222/json` 连接被拒 ⇒ 该实例启动时未带 `--remote-debugging-port`，
   而调试端口**只在启动时读取**，运行中无法开启）；
   ② 数据目录确实存在：`%LOCALAPPDATA%\com.prism.desktop\EBWebView\Default\Local Storage\leveldb`，
   但直接解析 LevelDB 需要一个未安装的读取器，且运行中的实例持有文件锁——手搓二进制解析很可能产出**错的样本**，
   比没有样本更糟。⇒ 按施工单 §三-2「取不到就写明原因继续」处理。
   本刀**不改持久化格式、不依赖它**；若刀3 需要，最省事的路子是**用带调试端口的方式重启一次 app** 后直接读
   `localStorage.getItem('pylon-theme')`。
2. **`terminal-cc.ts` 709 行**（超施工单 ~400 行阈）。原因与为何不进一步拆分见「方案要点 5」；
   若要更细的组织（如按条目拆），需要施工单先授权第三种组织方式。
3. **判据的边界**：手改 localStorage 塞一条 `origin: 'factory'` 的条目，会得到一条"不可删但也不属于数据表"的行。
   无 UI 路径能造出它；池在物化持久化条目时已把它改写为 `custom`（`zonePresetsFor` 里显式补 `origin: 'custom'`），
   但**存储层本身没有校验**——留作将来加持久化 schema 校验时的注意点。
4. **生成脚本未接进 CI**（`package.json` 不在本刀文件清单内）。当前靠门禁命令手工跑；
   若要让它在 CI 常态生效，需要在 `package.json` 的 `check:frontend` 链上挂一条（另一个改动面）。
5. **刀3 会删掉本刀的两个参考实现与生成脚本**（见「方案要点 4」的退出条件）。

## 并行交集

本次碰过的共享文件（供其他贡献者避让）：

- `src/zones/zonePresetPool.ts`（**结构性改动**：条目类型、判据、池来源；签名未变）
- `src/zones/index.ts`（门面转出）
- `src/components/Settings.tsx`（**只有 `ZonePresetRow` 的 title 分支与一处注释**，观感未动）
- 新增目录 `src/zones/factory/**`（10 数据文件 + 索引）
- 新增 `scripts/generate-factory-zone-presets.mts`
- 测试：新增 `src/zones/__tests__/factoryZonePresets.test.ts`；修改 `src/zones/__tests__/zonePresetPool.test.ts`（仅 `:61-96`）
- `.agents/L.md`（文件域声明，已单独提交 `68908c0e`）

未声明、也未触碰：`src/application/transactions/applyGlobalPreset.ts`、`src/domains/theme/**`、
`src/presets/**`、`src/store.ts`、`src/themeFieldDefs.ts`、`src/zones/pickZoneFields.ts`、
`src/renderers/**`、`src-tauri/**`、`tools/**`、`package.json`、`docs/**`。
