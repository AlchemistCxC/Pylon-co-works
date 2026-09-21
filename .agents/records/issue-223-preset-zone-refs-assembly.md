# 开发记录 · #223 预设组装 刀1 —— 区域引用表 + 装配路径倒置

## 元信息

- issue：[#223](https://github.com/AlchemistCxC/Pylon-co-works/issues/223)（类型 `refactor`）
- 分支：`feat/preset-assemble.1`（基于 `origin/main @ 5e251b40`，上游跟踪**已解掉**）
- 提交范围：`9eb8363a..cd21829d`
  - `9eb8363a`（工作者本轮所出）：仅 `.agents/L.md` 文件域声明（施工单 §三-3 要求单独提交使其对他 agent 可见）
  - `cd21829d`（★ **由用户 AquaTur5235 于 2026-09-21 13:28 提交，非工作者本轮所出**）：本刀 6 个文件（5 源文件 + 新增测试）。分支**无上游、未 push**
- 日期：2026-09-21
- 上游文档：规范 `预设修正/预设组装/00-施工规范-预设组装-v1.0.md`（v1.0 定稿）；施工单 `预设修正/预设组装/01-施工单-刀1-区域引用表与装配倒置.md`
- 前置备份（规范 §10）：`预设修正/备份/预设组装-前存档-20260921/`（含可重跑脚本 `dump-presets.ts` + `索引.md`）

## 目标与范围

**目标**：给整套预设加一张「区域引用表」（`zoneRefs`），并把「应用整套预设」从**一次性写全量**倒置为**逐区域装配**（5 块独立的区域预设 → 拼成一套预设）。

**不做什么**（施工单 §2.5，逐条守住）：

- ❌ 不搬区域预设数据（**仍派生**；`deriveZonePresetPool` / `ZONE_PRESET_POOL` 一行未动）
- ❌ 不动 `completeTerminalPreset`（拆它是刀3）
- ❌ 不动 `ccLayout` 逻辑（把定位收进区域预设是另一条已立档待办）
- ❌ 不动 UI（`Settings.tsx` / `TemplateLibrary.tsx` 一字未改）
- ❌ 不改自定义预设那条路（`customPresets` / `presetBundle` / v2 包）
- ❌ 不 bump 任何版本号（`THEME_SCHEMA_VERSION` 仍 11、`CC_LAYOUT_SCHEMA_VERSION` 仍 9）
- ❌ 不碰 `src/ui-demo/`、`src/layout-sketch/`、`docs/前端接口地图.md`

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/presets/types.ts` | `GlobalPreset` 增可选 `zoneRefs`；`PresetZone` 用 `import type` 从 `presetReducer.ts` 引入 | 修改 (+12/−0) |
| `src/presets/builtin.ts` | 10 套 `RAW_GLOBAL_PRESETS` 各显式写出 5 项 `zoneRefs`（`DEFAULT_PRESETS` 不加） | 修改 (+21/−0) |
| `src/domains/theme/presetReducer.ts` | 新增 `requireZoneRefs` / `assertZoneSliceOwnership` / `assembleGlobalPresetReducer` 及其类型；既有 `setGlobalPresetReducer` **保留**为参考实现与回落路径 | 修改 (+119/−1) |
| `src/application/transactions/applyGlobalPreset.ts` | `planGlobalPreset` 的 plan 增 `interfaceMode` / `zoneRefs` / `profileTokens`；新增 `expandGlobalPresetZoneRefs`；`applyGlobalPreset` 分两条写路 | 修改 (+61/−3) |
| `src/store.ts` | 新增薄壳 `assembleGlobalPreset(slices, options?)`（**只动预设那两个 action 的邻域**，其余一行未动） | 修改 (+19/−0) |
| `src/__tests__/presetAssembly.test.ts` | B1–B6 全部新增断言 | **新增**（20 用例） |

合计 **+232 / −4**（5 个源文件）；测试文件另计。

## 方案要点

### 1. 引用表与装配流程

```
applyGlobalPreset(name)
  └─ planGlobalPreset()          产出 presetName + interfaceMode + theme + zoneRefs(+profileTokens)
       └─ expandGlobalPresetZoneRefs(bucket, zoneRefs)   引用 → 逐区域切片（复用 zones/ 的既有解析）
            └─ store.assembleGlobalPreset(slices, opts)   薄壳：记溯源 + set(reducer(state, args))
                 └─ assembleGlobalPresetReducer(state, slices, opts)   纯层产出 patch
```

- **引用表解析放哪**：解析本身复用 `src/zones/zonePresetPool.ts` 的既有纯函数 `resolveZonePresetEntryTheme`（**该文件一行未改**），按 `(界面模式桶, 区域, 引用 id)` 在 `ZONE_PRESET_POOL` 里查条目；**跨桶 / 跨区域 / 不存在的 id 一律抛错**（同桶约束 = 规范 §4.1 硬约束 3）。刀2 把出厂条目落成独立数据后，这一处自动改读新数据源，不需要再改装配层。
- **为什么 `assembleGlobalPresetReducer` 不自己解析引用**：`presetReducer.ts` 若 import `zonePresetPool.ts` 会构成 **import 环**（后者已 import 前者的 `PRESET_ZONES`）。所以解析留在 `zones/` 侧、由 shell 驱动循环，纯层只吃已展开的切片。

### 2. 三条硬约束各自怎么落的

| 硬约束 | 落法 |
| --- | --- |
| ① **保留全量换装铺底** | `assembleGlobalPresetReducer` 的第一行就是 `let patch = { ...filterPresetTheme(DEFAULTS) }`，之后每个区域只往上盖自己那一片。**R1 反向验证**证明：去掉这一行，用户改过的字段会残留（B3 直接红，报 `expected 'zz-刀1-dirty' to be 'system'`） |
| ② **复用 `applyZonePresetReducer`，不新写合并逻辑** | 循环体内唯一写字段的动作是 `applyZonePresetReducer(...)`，cc 区两条特殊处理（`ccLayout` 归一、`ccHeight` 收敛）天然在其内。B4 锁住：claude 裸值 76 → 装配后 84，且与旧路径相等 |
| ③ **按 `PRESET_ZONES` 顺序逐步累积** | 每轮的输入是 `{ ...state, ...patch }`（上一步结果并进下一步的输入），**不是**「5 个区域各算一份 patch 最后合并」——后者会让 `appliedPreset` 互相覆盖（每份 patch 都带着自己那份完整的 `appliedPreset`） |

### 3. 取值与记名解耦

`assembleGlobalPresetReducer` 的 `appliedName` 选项：省略 ⇒ **逐区域记各区域的引用 id**（刀4 的用法）；给值 ⇒ 5 个区域**统一记这个名字**。★ 这正是重置路径要的语义：取值来自**默认预设**，但名字必须是空串——默认预设不进列表，按它的名字记名会让预设行认不出它而亮出兜底 chip「未知预设」。

`patch.appliedPreset` / `patch.custom` 在循环之后**按 `PRESET_ZONES` 重建**（而不是直接用中间结果），键集恒等于 5 项、不夹带 `state` 的额外键 ⇒ 与旧路径逐字节同形。

### 4. 为什么把旧路径留着

`setGlobalPresetReducer` 与 store 的 `setGlobalPreset(name, theme)` 都保留：

1. 施工单 §4.2-B2 明确要求「旧路径保留为参考实现，只用于测试」；
2. 两条默认预设（`DEFAULT_PRESETS`）本刀**不加 `zoneRefs`**（终端默认是 `glass` 的**拷贝**而非引用；引 `glass` 会成跨桶引用）⇒ 他们是**活着的回落路径**，不是死代码；
3. 既有测试 `defaultPresets.test.ts` 直接调用 `setGlobalPreset('glass', GLASS.theme)`——本刀不许改既有测试，签名必须原样。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| A1 全量测试（既有部分同数同结果） | ✅ 615→**616** files、4530→**4550** passed、failed **0**、todo 1；增量恰好 = 新测试文件（+1 文件 / +20 用例） |
| A2 契约快照（★ 口径 2026-09-21 已订正为「除时间戳一行外逐字节不变」） | ✅ `--numstat` 1 增 1 删（仅 `generatedAt`）；第 3 行起 `diff` **无输出**、5348 行相同；验完已 `git checkout --` 还原 |
| A3 出厂预设内容零变化 | ✅ 10 套 + 2 套默认预设逐字段相同；50 条区域切面逐条相同；**按现在的代码重跑导出，三份产物与前置存档 md5 逐字节相同** |
| B1 引用表覆盖完整（缺项必须抛错） | ✅ 10 套键集精确等于 `PRESET_ZONES`；缺任意一项逐个抛错、缺表/空串/非区域键也抛错 |
| B2 新旧装配等价（10 套 + 2 套默认预设） | ✅ 逐套「键集相同 + `toEqual`」；三套带呈现方案的另验 token 覆盖；默认预设验「五区切面并集 == 整份 theme」并真装一遍 |
| B3 全量换装语义 | ✅ 用户改过的未覆盖字段装配后回 `DEFAULTS`（纯层 + 真实事务两条） |
| B4 cc 区特殊处理保留 | ✅ `ccLayout` 归一（丢掉用户拖拽排布）；`ccHeight` 收敛（76→84） |
| B5 不许串区 | ✅ 50 条出厂条目值键全部属于自己区域；逐区逐字段对拍「装配 X 时非 X 区一个都没变」；越区键抛错；引用指错桶/区域/不存在抛错 |
| B6 重置路径记名 | ✅ 装配层取值/记名分离；`resetTheme` 两模式下 5 区基准全空且不亮兜底 chip |
| §4.3 回归清单（6 个既有测试文件，**一字未改**） | ✅ 61 passed |
| 门禁五步 + 两条 preset 专用脚本 | ✅ 全绿（见下） |

## 测试处置

**零修改、零删除**；只新增 `src/__tests__/presetAssembly.test.ts`（20 用例）。
★ 施工单 §4.3 点名的既有断言（`zonePresetPool.test.ts:111`、`defaultPresets.test.ts:116-135/137-160/163-177/179-190/192-199`、`presets.test.ts:77-80`、`applyGlobalPreset.test.ts:41-55`、`themeDefaults.test.ts:18-21`）全部保持绿，**未被触碰**。

## 证据

- **commit**：`cd21829d`（本刀 6 个文件，+659/−4，用户提交）+ `9eb8363a`（L.md 声明，工作者提交）；分支**无上游、未 push**
- **门禁**（顺序未跳；★ 全部在 `cd21829d` 这一版上复验过，`git diff HEAD` 为空）：
  - `bun run lint` → 0 errors（1 个既有 warning 在 `RightRailHost.tsx`，非本单文件）
  - `bun run build:example-plugin` → `dist/entry.js + dist/styles.css + dist/entry.d.ts 已由 src/ 重建`
  - `bun run build` → `tsc -b` 无错；`✓ built in 11.12s`
  - `bun run check:solid` → 全部子门禁通过（含 `ZONE_FIELDS 一致性契约通过（191 个主题字段）`、CSS 消费审计、工作台皮肤 contract、插件 API allowlist、hook anchor parity）
  - `bun run test` → `Test Files 616 passed (616)` / `Tests 4550 passed | 1 todo (4551)`，EXIT=0
  - `bun scripts/check-theme-field-consistency.mts` → 通过（191 字段）
  - `bun scripts/check-workbench-theme-contract.mts --write` → 内置预设 10 / 自定义 0 / 主题字段 191 / CSS 变量 98 / fixture 15
- **A3 逐字节**（存档 vs 按现在的代码重跑导出）：

  | 文件 | md5 | 对照 |
  | --- | --- | --- |
  | `global-presets.json` | `75ed15819986e33cc30536d49ba47a44` | 相同 |
  | `default-presets.json` | `ff00ef4c11bbaf2cc229dedaef26e7b9` | 相同 |
  | `zone-slices.json` | `c8a45cc4824b81c967d6d767c5d717c2` | 相同 |

- **A2 逐字节**：
  ```
  $ git diff --numstat -- src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json
  1       1       src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json
  $ diff <(git show HEAD:<快照> | tail -n +3) <(tail -n +3 <快照>)     # 无输出
  $ git show HEAD:<快照> | wc -l → 5348 ;  wc -l < <快照> → 5348
  ```
- **未动的面**（`git status` 为空验证）：`Settings.tsx`、`TemplateLibrary.tsx`、`zonePresetPool.ts`、`pickZoneFields.ts`、`themeFieldDefs.ts`、`completion.ts`、`workbenchSkinContract.ts`、`migration.ts`、`ccLayoutState.ts`、契约快照 JSON。`applyGlobalPreset(name, ports?): boolean` 签名逐字未变。

### 反向验证（R1–R4，改坏 → 变红 → 改回；无残留）

| # | 改坏什么 | 结果 |
| --- | --- | --- |
| R1 | 去掉铺底（`let patch = {}` 取代 `filterPresetTheme(DEFAULTS)`） | **B3 红**：`glass/globalFont 必须回默认值: expected undefined to be 'system'`；真实事务那条 `expected 'zz-刀1-dirty' to be 'system'` |
| R2 | 装配层不再调用越区校验 | **B5 红**：`越区键必须报错` 那条 `expected [Function] to throw an error`（直调校验器那一半仍绿——它测的是校验器本身，不在被改坏的路径上） |
| R3 | 让引用指向错误的区域（每区都查 `sidebar` 那一格） | **B5 红**：`claude：装配 global 时动了 sidebar 区的 sidebarBg: expected '#000000' to be 'zz-刀1-dirty'`；另一条抛 `区域 global（引用 claude）：区域 global 的取值含越区/未知字段（sidebarBg / sidebarBgImage / sidebarWidth / …）` |
| R4 | 重置按默认预设名记名（`setGlobalPresetReducer(target.name, …)`） | **B6 红**：兜底 chip 出现 `expected { label: '未知预设', title: '未识别的预设标识：gui-default' } to be null`；`appliedPreset` 那条 `expected 'gui-default' to be ''` |

改回后 `grep -rn "★R[1-4] 反向验证" src/` 无残留，新测试恢复 **20/20 绿**。

## 与 spec 的偏差

1. **装配层的解析/循环分工**：规范 §6 要求「引用表怎么解析必须落在纯层」，施工单 §2.3 描述为「shell 用 zones/ 的解析把引用展开」。落实为：**解析本体仍是被复用的纯函数**（`resolveZonePresetEntryTheme`，未改），**循环由 shell 驱动**（因为纯层直接 import `zonePresetPool` 会成 import 环）。两者都满足。
2. **store 的接口形态**：施工单 §2.3 写「store 薄壳：`set(patch)`」。实际新增了一个同性质的 action `assembleGlobalPreset(slices, options?)`，而非改既有 `setGlobalPreset` 的签名——因为 `defaultPresets.test.ts` 直接调用 `setGlobalPreset(name, theme)`，改签名就得改既有测试（本单禁止）。
3. **`resetTheme` 本刀仍走旧路径**：默认预设无 `zoneRefs` ⇒ 回落「整份 `theme`」。装配层的 `appliedName`（取值/记名解耦）已按 §2.4-1 备好并测试锁住，但**本刀没有生产调用点**（留到默认预设也上引用表的刀次）。
4. **A2 验收口径**：原写「增删行数 = 0」天生不可满足（`generatedAt` 默认取 `new Date()`）。已由翻译在施工单内订正为「除时间戳一行外逐字节不变 + 验完还原」，本记录按订正后的口径提交结果。
5. **A1 的口径**：施工单同时要求「只允许新增测试」与「B1–B6 五条都要有」，故 files/passed 必然有增量。按「既有部分完全相同、增量恰好等于新测试」验收（+1 文件 / +20 用例 / failed 与 todo 均不变），已逐项对上号。

## 未解问题

1. ★ **引用表与「同形折叠」互斥（潜伏，未来会炸）**：区域池会把**内容相同**的切面折叠成一条（id 取排序最前的来源预设名，另一套记在暗处的 `sources`），而每套预设的 `zoneRefs` 写的是**自己的名字** ⇒ 被折叠掉的那套引用会指向池里不存在的 id，`expandGlobalPresetZoneRefs` **抛错**、该预设装不上。**当前两桶每格恰好 5 条、一条都没折叠过，故未暴露**；一旦开始认真去重或任何一次预设编辑让两块同形就会触发。已立档：`预设修正/待办/区域引用表与同形折叠冲突-待办.md`（三个修法待拍板，建议随刀2一起解决——刀2 正是「让区域预设成为独立数据」，那时 id 命名体系必须一次定清）。
2. **`appliedName` 无生产调用点**：见「与 spec 的偏差 3」。
3. **`profileTokens` 叠加位置的一个前提**：硬约束 4 要求呈现方案 token 在装配**之后**叠加，而 token 会改 `ccHeight` clamp 的输入（`inputMode` / `footerLayout` / `cliHintMode`）。实测 10 套的 clamp 结果在「预设⊕token」与「只看预设」两种输入下**完全一致**（claude 84；glass/nord/tokyo/solarized/amber/matrix/agent-command/agent-map 96；focus-flow 88）⇒ 本刀位置选择不改变任何值，且由 B2 的逐字段对拍兜住。若**将来**新增的带呈现方案预设引入了 clamp 敏感的组合，这里需要重新审。
4. 规范 §10 第 3 项（实机 localStorage 的 `pylon-theme` 样本）本刀未做，按施工单 §三-2 留到刀2 开工前。
5. 本记录的 `A2` 结论依赖快照文件的「第 3 行起」判据；若将来快照头部结构变化（新增字段行），该判据需同步调整。

## 并行交集

本次碰过的共享文件（供其他贡献者避让）：

- `src/presets/types.ts`、`src/presets/builtin.ts`
- `src/domains/theme/presetReducer.ts`
- `src/application/transactions/applyGlobalPreset.ts`
- `src/store.ts`（**只有预设那两个 action 的邻域**：`setGlobalPreset` 后新增了一个 action；`resetTheme` 未改）
- `src/__tests__/presetAssembly.test.ts`（新增）
- `.agents/L.md`（文件域声明条目，已单独提交 `9eb8363a`）

未声明、也未触碰：`src/zones/**`、`src/themeFieldDefs.ts`、`src/components/Settings.tsx`、`src/components/settings/TemplateLibrary.tsx`、`src/domains/workbench/**`、`src/renderers/**`、`src-tauri/**`、`tools/**`、`docs/**`。
