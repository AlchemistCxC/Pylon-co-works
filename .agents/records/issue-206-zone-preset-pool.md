# Dev Record — #206 刀6 区域预设池（界面模式 × 区域）

> 入库保留。施工单：仓外 `预设修正/预设系统V2/06-施工单-刀6-区域预设池.md`；规则唯一来源：同名目录 `06-规则提案-区域预设池派生-待拍板.md`。

## 元信息

- issue：#206（总 issue #109）
- 分支：`feat/preset-v2.6`（自 `4dace7e9` 开）
- 提交范围：`4dace7e9..<待收口>`
- 日期：2026-09-20

## 目标与范围

**做**：把「区域预设」从派生物变成按 (界面模式桶, 区域) 组织的独立数据——新增池模块（出厂条目存引用、自定义条目存值快照）；`ZonePresetRow` 候选改从池取并新增「存当前」入口；Q8 已删字段键自动清理 + 行内占位。

**不做**：不动 `pickZoneFields` / `ZONE_FIELDS` / `PRESET_ZONES` 本体；不动预设「值」（GLOBAL_PRESETS 一字不改）；不做区域预设的编辑 UI（只能存当前与应用）；不做语义供源 / 警示色可定制；不碰刀5 的两级菜单结构；不开 PR。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/zones/zonePresetPool.ts` | 池类型 `ZonePresetEntry` / `ZonePresetPool`、切面指纹稳定序列化、`deriveZonePresetPool` + `ZONE_PRESET_POOL`、Q8 清理与归一、`zonePresetsFor`、`resolveZonePresetEntryTheme`、`createZonePresetEntryId` | 新增 |
| `src/zones/__tests__/zonePresetPool.test.ts` | 派生 / 去重 / 空池 / 切片等价 / 隔离 / 存取与持久化 / Q8 / Row 消费，共 11 条 | 新增 |
| `src/zones/index.ts` | 门面导出新增模块（含类型） | 修改 |
| `src/store.ts` | 状态切片 `zonePresetEntries`、动作 `saveZonePresetEntry` / `pruneZonePresetEntries`、`partialize` 落盘 | 修改 |
| `src/components/Settings.tsx` | `ZonePresetRow` 改从池取 + 「存当前」入口 + 空池整组不渲染；`applyLocalPreset` 改为消费条目 | 修改 |
| `src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css` | §八-2 仅 `.set-preset-chip.active` 一条规则补 `text-decoration:underline; text-underline-offset:3px;`（方案 A：叠加，保留填充+加粗） | 修改 |
| `src/components/__tests__/Settings.customPreset.test.tsx` | §八-1 同步 1 句断言文案（改断言，非新测试） | 修改 |
| `.agents/L.md` | 本单文件域声明（含 §八 追加的两个文件） | 修改 |

## 方案要点

1. **出厂条目是构建时派生表**：`presetsForInterfaceMode(桶) × PRESET_ZONES × pickZoneFields` → 切面指纹去重；`id === 来源预设名` ⇒ `appliedPreset[zone]` 记的名字与刀5 逐字一致。条目本身不入库。
2. **指纹与顺序无关**：字段按 `ZONE_FIELDS` 顺序取值、对象键递归排序后 JSON 化；两个预设以不同键序写同形切面仍折叠（测试用 a1/a2 的乱序 `theme` 锁住）。
3. **`sources` = 折叠进该条的其余来源**（不含 label 那个），仅在 ≥2 来源时存在；行内以 `title` 作备注。
4. **自定义条目存值快照**（铁律「存引用不存值」的拍板例外）：存 = `pickZoneFields(当前主题, zone)`，应用 = 同一份快照交回既有 `applyZonePreset` ⇒ 「存当前 → 应用」对界面幂等。
5. **持久化沿用 `pylon-theme`**：新切片与 `customPresets` 同键同白名单（`partialize` 显式列入），条目 `id = zone-<mode>-<zone>-<now>`（撞号加后缀）⇒ **键含模式 + 区域**。未 bump `THEME_SCHEMA_VERSION`（v11）——新键在存量数据里必然缺失，读路径自带容错归一，不依赖 migrate 钩子。
6. **Q8 落到「键」而非「条目」**：每次读取把不在 `ZONE_FIELDS[zone]` 里的键从快照中丢掉（`zonePresetsFor` 与 `pruneZonePresetEntries` 两处同源）；清空后无有效字段的条目退化为**行内占位**（`disabled` chip，灰色、不可应用、无开关），**条目记录保留**（不静默删用户数据）。
7. **未登记模式**：`zonePresetsFor` 查不到归属桶 ⇒ 空数组 ⇒ `ZonePresetRow` 返回 null（整组不渲染，`tactical-blue` 与插件未登记模式同口径）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 每格条数报告（≤ 桶大小、去重正确、sources 佐证） | ✅ 10 格（5 区 × 2 桶）实测**均为 5 条**——本批 10 个内置预设两两切面不同，**实际发生 0 次折叠**；折叠逻辑由合成输入单测证明（3 预设 → 2 条，`sources: ['solarized']`） |
| `tactical-blue` / 未登记模式 ⇒ 空池、整组不渲染 | ✅ |
| 应用行为零变化（出厂条目切片 = `pickZoneFields(来源预设.theme, zone)`） | ✅ 逐格逐条深比对 |
| 自定义：存当前 → 自定义 chip → 应用恢复 → 持久化 | ✅ 写盘内容 + 读入路径还原均断言 |
| Q8：已删字段键 ⇒ 自动清理 + 占位 | ✅ 三处断言（清理结果 / `stale` 占位 + 不可应用 / 界面 disabled chip） |
| `pickZoneFields` / `ZONE_FIELDS` / 预设 theme 值零改动 | ✅ `git diff --stat` 不含这三个文件 |
| 门禁五步全绿；契约快照重拍零 diff | ✅ |
| 新增测试全部反向验证 | ✅ 9 处改坏 → 11 条新测试每条至少一处变红 |
| `git status --porcelain` 只含本单文件 | ✅ 另见 3 条禁区未跟踪项原样未动 |
| §八-1 三处文案一致（旧文案 0 残留；既有断言已同步） | ✅ |
| §八-2 下划线只在 `active` 态（`hover` / `disabled` 规则不带） | ✅ CSS 内 `text-decoration` 仅 1 命中且在 `.active` 行 |
| §八-3 `aria-current` 只落 3 处预设 chip（浅色/深色不加）；新增 1 条断言绿 + 反向验证 | ✅ `grep -c aria-current src/components/Settings.tsx` = 3 |

## 测试处置

追加变更（§八）动到**既有断言 1 处**（点名）：`src/components/__tests__/Settings.customPreset.test.tsx:82` 的 `toHaveTextContent('覆盖自定义预设失败：capture failed')` → `'覆盖已有自定义预设失败：capture failed'`。原因是操作名改了、原子串必然失配——**属改断言，不是新测试，不做反向验证**（`02` §四 口径）。除该断言外本轮没有新增功能测试；§八-3 只加 **1 条断言**（`选中的区域预设 chip 带 aria-current`），已走反向验证（去掉 `aria-current` → 该条红，`Received: null` → 还原，源码哈希 MATCH）。

- **新增** `src/zones/__tests__/zonePresetPool.test.ts`（11 条，全部反向验证：M1–M9 九处改坏，逐条对应变红，改回后源码哈希 MATCH）。
- **既有测试：逐个点名改写清单 = 空**。理由：`ZonePresetRow` / `applyLocalPreset` 此前**没有任何既有测试点名覆盖**（全仓 grep `局部预设` / `applyZonePreset` / `ZonePresetRow` 在测试目录 0 命中）。候选来源变化后实测既有 Settings / 主题预设相关 3+7 个测试文件全绿（`Settings.globalPresetMenu` / `Settings.customPreset` / `B-03-settings-dialog` / `Settings.a11y` / `Settings.agentOnboarding` / `Settings.pluginManagerDefaultPage` / `presets` / `themePresetState` / `customPresets` / `domains/theme`），**未改动、未删除任何既有测试**。

## 证据

- 门禁：`bun run lint`（0 error）/ `build:example-plugin` / `bun run build`（tsc -b + vite）/ `bun run check:solid` / `bun run test`（全量，计数见收口提交说明）
- 反向验证：9 处定向改坏，见施工汇报
- 快照：`bun scripts/check-workbench-theme-contract.mts --write` → 内置预设 10 个、主题字段 191 个，`git diff` 零 diff

## 与施工单的偏差

1. **`sources` 语义**按提案 §三算法伪码取「除 label 来源之外的其余来源」（施工单 §一.1「其余记 sources」同义），不是「全部来源」。
2. **池的派生轴**为 `PRESET_ZONES` 全 5 区（含 `global`），而施工单 §四写「gui×4 区、terminal×4 区共 8 格」。`ZonePresetRow` 只挂在 sidebar/chat/cc/right 四处（`global` 走「全局预设」菜单），故 `global` 格派生但不消费。汇报按 10 格给出，8 格数据为其子集。
3. **Q8 不删条目**：§1.7 表格「自定义区域预设内部 → 自动删除该无效条目」针对「自定义条目 → 用户自加元件」的悬空边；刀6 条目存的是主题值快照、无元件引用，施工单 §一.3 已收敛为「已删字段键 ⇒ 自动清理」⇒ 清理对象是**键**。条目保留为行内占位（否则无占位可显示，且会静默删用户数据）。若要求连记录一并删除，需施工方回改。
4. **自定义条目的持久化形态**由施工方定（单已授权）：单切片 + `id` 含模式与区域，而非按 (mode, zone) 分文件/分键。

## §八 追加变更（同日）

用户口径的三处小改，**不动任何逻辑 / 数据 / 派生规则**：

1. **文案统一**：`Settings.tsx` 2 处操作名 + 1 处提示句统一为「覆盖已有自定义预设」；既有断言同步 1 处。
2. **选中标记**：`.set-preset-chip.active` 叠加 `text-decoration:underline; text-underline-offset:3px`（**临时方案**）。已知副作用：所有 `active` chip 带线，含「浅色 / 深色」那组与区域行「自定义」灰 chip——用户判定语义一致、可接受，不另加专用类。
3. **选中语义**：三处预设 chip（全局 / 区域 / 兜底）加 `aria-current="true"`；「浅色 / 深色」属单选组语义，不加。值取 `'true'` 与 `src/sheets/SettingsSheetSidebar.tsx:77` 既有写法一致（`src/index.css:388` 的全局 `[aria-current="page"]` 规则只匹配 `"page"`，不会误命中）。

## 未解问题

- 自定义区域预设**没有删除入口**（施工单非目标 3 只允许「存当前」与「应用」；未提删除）。长期会累积条目，待后续刀处置。
- 真机（Tauri/WebView2）未跑：持久化证据取自写盘内容 + 读入路径还原，非真实重启。

- §八 追加载入共享文件：`src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css`（已补进 `.agents/L.md` 文件域；**该修改尚未提交**，按本轮指令「不 commit」）。
- `check:first-party-styles` 本机红：点名 `src/layout-sketch/LayoutSketch.css`、`src/ui-demo/UiDemo.css` 两条**禁区未跟踪目录**（`未登记 CSS`），与本单无关（失败清单里没有本单文件）；CI 干净检出不包含这两个目录。

## 并行交集

- 新增/独占：`src/zones/zonePresetPool.ts`、`src/zones/__tests__/zonePresetPool.test.ts`
- 触碰的共享文件：`src/zones/index.ts`、`src/store.ts`、`src/components/Settings.tsx`、`.agents/L.md`
- 未碰：`src/presets/**`、`src/zones/pickZoneFields.ts`、`src/themeFieldDefs.ts`、`src/domains/theme/**`、`src/renderers/**`、`src-tauri/**`、`tools/**`、`docs/说明书/**`（无相关表述，见下）
