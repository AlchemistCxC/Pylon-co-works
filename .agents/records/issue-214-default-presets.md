# Dev Record — #214 刀7：两套默认预设（GUI / 终端）

> 入库保留。施工单：仓外 `预设修正/预设系统V2/07-施工单-刀7-两套默认预设.md`。与前置 07a（#211）**同批同分支同 PR**。

## 元信息

- issue：#214（总 issue #109；2026-09-20 登记，认领 assignee=AquaTur5235）
- 分支：`feat/preset-v2.7`（自 `main@399d1423` 开；07a 已本地存档 `40487a7c`）
- 日期：2026-09-20

## 目标与范围

**做**：两条默认预设（`GUI-默认预设` / `终端-默认预设`）＋把「重置主题」的落点从「整份 DEFAULTS」改为「当前界面模式的默认预设」。

**不做**：不动既有 10 套预设的值；不动刀6 派生规则 / 池结构 / `pickZoneFields`；不动预设菜单 UI（`Settings.tsx` 零改动）；不做刀8/刀9；不新增 CSS 家族；不动 `activateInterfaceMode` 事务本身。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/presets/types.ts` | `PresetName` 增 `'gui-default'` / `'terminal-default'` | 修改 |
| `src/presets/builtin.ts` | 新增 `requireGlobalPreset`、`GLASS_THEME`、`TERMINAL_DEFAULT_THEME`、`DEFAULT_PRESETS`、`defaultPresetForInterfaceMode` | 修改 |
| `src/store.ts` | `resetTheme` 落点改为当前模式的默认预设（未登记模式回落 `DEFAULTS`）；新增两个 import | 修改 |
| `src/domains/theme/presetReducer.ts` | §六：`setZoneFieldReducer` 增 `markCustom` 入参（默认 `true`）+ 注释 | 修改 |
| `src/__tests__/defaultPresets.test.ts` | **新增**（12 条 = 9 条主体 + 3 条 §六） | 新增 |
| `.agents/L.md` | 本单文件域声明（开工时单独提交 `1a08fb6c`） | 修改 |

## 方案要点

### 1. 落点：独立表，而不是 `GLOBAL_PRESETS` 加标记

施工单 §一.2 把落点交给施工方并提示风险（同数据源时必须让「列表」与「池」两处都排除）。选择**独立表** `DEFAULT_PRESETS: Record<PresetInterfaceMode, GlobalPreset>` 的理由：

| 项 | 独立表（本实现） | `GLOBAL_PRESETS` 加标记 |
| --- | --- | --- |
| 列表排除 | **结构性**：`presetsForInterfaceMode` 只读 `GLOBAL_PRESETS` | 需改过滤分支 |
| 池排除 | **结构性**：`zonePresetPool` 派生表只读 `GLOBAL_PRESETS` | 需改派生 |
| 漏一处即漏进候选菜单 | 不可能 | 是真实风险 |
| 既有断言 | `GLOBAL_PRESETS.toHaveLength(10)`（`presets.test.ts:77`、`templateThemeVars.test.ts:23`）**零改动** | 两条必红、须改既有测试 |
| 文档「当前 10 套内置预设」 | **不失真**（`Pylon-插件系统说明书-用户版.md:267`） | 失真，须先报备再动文档 |

「同定位」由形状与路径保证：两条都是 `GlobalPreset`（同类型、同应用路径 `setGlobalPresetReducer`），只是不进那条「列表用」的数据源。

### 2. 外观来源

- **GUI**：`theme: GLASS_THEME`（**引用** `glass` 的同一份 theme 对象，`toBe` 关系由测试锁住 ⇒ 不可能与 glass 漂移）。
- **终端**：`structuredClone(glass.theme)` + 终端契约 5 字段 —— `msgStyle:'terminal'` / `messageLayout:'classic'` / `inputMode:'cli'` / `inputVariant:'cli'` / `ccVariant:'terminal'`（写法对齐 `completion.ts` 的 `TERMINAL_VISUAL_COMPLETION`；`inputVariant` 必须与 `inputMode` 同写，因本仓有 `inputMode==='cli' ⟺ inputVariant==='cli'` 的联动不变量）。**深色预设一条不用**（用户已否决）。

### 3. `resetTheme` 落点

```ts
const target = defaultPresetForInterfaceMode(useInterfaceModeStore.getState().interfaceMode)
if (!target) { set(structuredClone(DEFAULTS)); return }          // 未登记模式：原样回落
set({ ...structuredClone(DEFAULTS), ...setGlobalPresetReducer('', target.theme) })
```
- **覆盖范围与原来逐字一致**：仍以整份 `DEFAULTS` 打底（含非预设域字段 `sidebarWidth` / `rightWidth` / `showPet`），只把**预设域字段**换成默认预设的值；`ccLayout` 归一与 `ccHeight` 收敛复用「应用预设」同一套算法 ⇒ 「重置后的样子 == 点该预设的样子」。
- **名字传空串**：沿用 `resetZone` 的「无基准」态（`appliedPreset=''` + `custom=false`）。若记名，`deriveGlobalStatus` 会返回一个列表认不出的名字，预设行就会亮出兜底 chip「未知预设」——正是刀6/07a 要避免的悬空。此点已单测锁住（`fallbackPresetChip(status, [])` 必须为 null）。

### 4. ★ 一条必须知悉的既有行为（不是本刀引入）

「重置主题」按钮走的不是 `resetTheme` 单点，而是事务 `resetThemeForActiveInterfaceMode`：**先 `resetTheme()`，再套该界面模式的 Presentation Profile**（`activateInterfaceMode.ts:129-145`）。因此目视结果 = **默认预设的外观 + 当前模式的呈现方案**（`modern-gui` profile 会把 `msgStyle:'bubble'`、`inputMode:'default'`、`ccVariant:'glass'` 等覆盖回去；`terminal-classic` profile 正好把终端契约 5 字段全设了一遍）。本刀**未改**该事务（施工单只要求改 `resetTheme`），这是既有设计：呈现方案本就按界面模式走。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 列表/池里都没有「默认预设」这类按钮（chip 行各 5 条，`queryByText` 为 null） | ✅ 数据侧 + UI 侧双断言 |
| 目视（用户亲自）· 两套各一遍 | ⏳ **待用户目视**（本轮未做，见「未解问题」） |
| 未登记模式（tactical-blue）重置 → 回落 DEFAULTS、不报错、不悬空 | ✅ |
| 重置后四区标记正确（不悬空、语义符合刀6 口径） | ✅ `appliedPreset` 全 `''`、`custom` 全 `false`、无「未知预设」chip |
| 出厂预设铁律不变：重置不修改任何出厂预设内容 | ✅ 基准取**模块加载时**快照（与测试顺序解耦） |
| 契约快照重拍内容零 diff | ✅（仅脚本自动写的时间戳，已还原） |
| 门禁五步全绿；新增测试反向验证四段 | ✅ Q1–Q7（主体）+ R1–R3（§六） |
| §六 真实事务断言（`resetThemeForActiveInterfaceMode`） | ✅ 全空 + 四区无 custom + 兜底 chip 不渲染 |
| §六 切换界面模式（modern-gui ⇄ terminal-like）同样不误标 | ✅ |
| §六 user-edit / field-reset 仍置 custom（其余 source 语义一字不动） | ✅ |
| PR：07a + 刀7 同批 | ⏳ 按指令本轮不开 PR（批末统一） |

## 测试处置

- **新增** 12 条于 `src/__tests__/defaultPresets.test.ts`（全新文件）：9 条主体（反向验证 Q1–Q7）+ 3 条 §六（反向验证 R1–R3）。
- **§六 未使任何既有测试变红**（逐条点名清单为空）：全量 609 文件 / 4478 用例全绿；另有 12 个触及呈现方案 / 设置写入的既有测试文件单独跑过。
- **既有测试零修改、零删除**。改 `resetTheme` 后实测风险面 5 个文件全绿：`domains/interface/__tests__/interfaceMode.test.ts`（含「四条重置/切换路径回到同一套 token」）、`domains/theme/__tests__/settingProvenance.test.ts`、`components/settings/__tests__/templateThemeVars.test.ts`、`__tests__/presets.test.ts`、`domains/theme/__tests__/presetReducer.test.ts`。

## 证据

- 门禁：`lint`（0 error）/ `build:example-plugin` / `build` / `check:solid` / `test`
- 反向验证：Q1–Q7（主体）、R1–R3（§六），见汇报
- 快照：`check-workbench-theme-contract.mts --write` → 内置预设 **10 个**（未变）、字段 191 个

## §六 追加变更（2026-09-20 · 用户目视发现）

**现象**：点「重置主题」后全局预设行亮兜底「自定义」chip，被呈现方案写过的区也亮「自定义」。

**根因链**：按钮走的事务 `resetThemeForActiveInterfaceMode` = `resetTheme()` + `applyModeProfile()`；`applyModeProfile` → `applyPresentationProfile` 经 `setZoneField(zone, patch, 'presentation-profile')` 写字段，但 store 只把 source 记进溯源、**没传给 reducer**，而 `setZoneFieldReducer` 无条件 `markZoneCustom` ⇒ 全局派生命中「任一 zone custom ⇒ `'custom'`」。★ 属既有行为（切换界面模式同样会亮），刀7 只是让它显得不对。

**修法（两层各一处，语义只改一个 source）**：
- `setZoneFieldReducer(state, zone, partial, markCustom = true)` —— reducer 不再自带「必定置 custom」的策略，只看入参；
- `store.setZoneField` 里 `sourceMarksZoneCustom(source) = source !== 'presentation-profile'` —— **策略唯一落点**在 store 漏斗口（source 就在那里）；`SettingWriteSource` 类型面**未新增取值**；
- 默认 `true` ⇒ 其余 7 个 source 语义逐字不变；`recordSettingWrites` 照旧记录（D-trace 不受影响）。

**范围提醒**：`presentation.apply`（CLI 命令）与设置页「呈现风格」选择器同样经这条路径 ⇒ 它们也不再置 custom（同一 source 同一口径，与施工单「按 source 决定」一致）。

**★ 上一轮测试链的缺口（本轮已补）**：旧断言只测 `resetTheme()`（store 单点），而按钮真实走的是上面那条事务（多一步呈现方案）⇒ 单测全绿而实机可见。本轮新增断言全部走**真实事务**，并先断言 `resetThemeForActiveInterfaceMode() === true` —— 事务返回 false 时它连 `resetTheme` 都不跑，不钉住这一点断言就是假的（该闸门的有效性已由 R3 反向验证证明）。

## 与施工单的偏差

1. ★ **§三 目视项写「终端 = `nord` 四区切面」与 §零②/§一.1 自相矛盾**：§零②（2026-09-20 拍板）与 §一.1 明确「终端复制 glass + 终端契约、深色几款已否决」，§三 那行是拍板前的残留。按**拍板口径**实现（glass + 契约），未按 §三 字面用 nord。
2. **终端契约字段取 5 个**（施工单点名 3 个 + `messageLayout` / `inputVariant`）：`inputVariant` 是本仓联动不变量的必需品（与 `inputMode` 同写），`messageLayout` 与另外三个在真实终端预设里同组出现。未加入 `cliHintMode` / `footerLayout`（那是密度偏好、施工单未点名；且在重置按钮那条路径上会被该模式的呈现方案覆盖，观测无差别）。
3. **`appliedPreset` 不记默认预设名**（施工单 §一.3 写「应用 `GUI-默认预设`」）：按 §一.5「不悬空」优先，取「无基准」态。理由见方案要点 3；若要求记名，需同步处理 `fallbackPresetChip` 才能不亮「未知预设」，属于要新增面的改动。
4. **`rightWidth` / `sidebarWidth` 不随重置变化**：`glass` 里这两条值本就被预设白名单挡掉（归属工作区布局 / 右栏），任何预设路径都写不进去 —— 与本刀无关的既有行为，已在测试注释里写明。

## 未解问题（§六 后）

- §六 修复**未做用户目视**：它影响「重置主题」与「切换界面模式」两处可见状态，建议并入本批目视一起看。

## 未解问题

- **用户目视未做**：两条默认预设的最终观感（尤其「默认预设外观 + 当前模式呈现方案」叠加后的结果）需用户亲自在真机上过一遍；若观感不符预期，最可能的调整点是本记录方案要点 4 那条既有叠加。
- 真机（Tauri/WebView2）未跑。
- 「母本」（默认预设是否还要承担其它预设的母本角色）按施工单 §零③ 留后。

## 并行交集

- 触碰：`src/presets/types.ts`、`src/presets/builtin.ts`、`src/store.ts`、`src/__tests__/defaultPresets.test.ts`（新增）、`.agents/L.md`
- 未碰：`GLOBAL_PRESETS` 本体（仍 10 套）、`src/components/Settings.tsx`、`src/zones/**`（刀6 派生规则与池结构）、`src/domains/theme/**`、`src/application/transactions/activateInterfaceMode.ts`、首方 CSS、`src/renderers/**`、`src-tauri/**`、`docs/说明书/**`（「当前 10 套」表述未失真，无需变更）
