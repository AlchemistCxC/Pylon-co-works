# Dev Record — #171 中控元件名单换代（旧 11 → 新 7）+ 刀4 续 · 空态极简

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-171-cc-roster-v2-and-empty-state-minimal.md`
> 一刀一 issue：本文件覆盖**同一交付内的两次施工**（刀4 主单 + 04b 续单）。

## 元信息

- issue：AlchemistCxC/Pylon-co-works#171（总 issue #109；前置锁见 #170）
- 分支：`feat/preset-v2.1`
- 提交范围：`d2beaf40..<本片 head>`（**本片尚未 commit**；`d2beaf40` = 施工起点，也是 tag `preset-v1-archive-20260918` 指向的提交）
- 日期：2026-09-18（刀4）· 2026-09-19（04b 续单）
- 施工单：`04-施工单-刀4-中控元件名单换代.md`（执行以 §零 刷新表为准）· `04b-施工单-刀4续-空态极简.md`
- 独立核验：`04` 单 §十二 · `04b` 单 §十（均翻译复跑通过）
- 署名：AquaTur5235

## 目标与范围

**要达成**（同一 PR、同一交付）：

1. **刀4 · 名单换代**：中控元件名单由旧 11 收缩为新 7 —— 保留 `input` / `model` / `reasoning` / `mode` / `tokens`，删 `session` / `workspace` / `activity` / `ekg` / `tasks`；legacy `send` 统一到注册轨 `cc-send-button`（F1=A）；「基础」`cc-surface` 只进预设捕获范围、不进 `CC_WIDGET_IDS`。删掉的元件连同**字段 / 属性键 / 组件 / CSS / 测试**一并清干净。
2. **04b · 空态极简**：无会话时中控收敛为「只有输入栏 + 背景板」——空态工作区选择器**隐藏保留**（可一行回退），空态隐藏 `cc-send-button` / `model` / `reasoning` / `mode` / `tokens` 五个控件，编辑模式豁免。

**不做**：不改 `sidebar` / `chat` / `right` 三区域；不重写 `src/presets/` 拆分结构；不重排保留项的 `order`；不写老数据兼容分支（交 `normalizeCcLayout` 白名单自然裁掉）；不改 `ccHeightState.ts` 档位算法；不动 `cc-surface` 背景板。

## 改动清单

33 个已跟踪文件（净 −773 行，`+476 / −1136`）。按职责块列（行号会立刻过期，故不给）。

| 职责块 | 文件 | 性质 |
| --- | --- | --- |
| 名单本体 / 字段组 / 可见性 | `src/domains/cc/widgetDefinitions.ts` | 修改（删 5 个 id、`ekg` 字段组、9 个 ekg/bar 属性键、`chipsBool` 机制；`isWidgetVisible` 只剩 hidden+editMode） |
| 标签 / 分类 / 默认槽位 | `src/domains/cc/widgetCatalog.ts` | 修改（三表删 5 键；`cc-send-button` 贡献补回 `defaultPlacement: actions/0`） |
| 布局与版本 | `src/ccLayoutState.ts` | 修改（`CC_LAYOUT_SCHEMA_VERSION` 8→9；白名单**显式保留 8**；`send` → `cc-send-button` 别名读取；新增 `CC_REGISTERED_SLOT_IDS` / `CcLayoutWidgetId`） |
| 主题 schema 迁移 | `src/domains/theme/migration.ts` | 修改（`THEME_SCHEMA_VERSION` 10→11；v11 说明；被删 9 字段键显式清除；`ccHidden` / `ccScale` 的 legacy `send` 改名） |
| 字段表 / store / 投影 | `src/themeFieldDefs.ts`、`src/store.ts`、`src/domains/workbench/appearance.ts`、`src/domains/workbench/workbenchAppearanceStore.ts`、`src/domains/theme/presetReducer.ts`、`src/ccHeightState.ts` | 修改（`ccStyle` + 9 个 ekg/bar 字段下线；`resolveVisibleStatusWidgetCount` 去掉 `ccStyle` / `presentationProfileId` 形参） |
| 皮肤 schema | `src/plugin-runtime/skin/skinSchema.ts` | 修改（`componentVariants['control-center']` 随 `ccStyle` 下线） |
| 渲染器 | `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | 修改（`WIDGET_LABELS` / 5 个 case / `SolidUsageGauge` / `taskLabel` / 工具栏数据源 = 内置轨 ∪ 占槽位注册轨；04b：`SHOW_EMPTY_WORKSPACE_CONTROL`、`EMPTY_STATE_HIDDEN_WIDGET_IDS`、`sendButtonMode()` 改读 `hiddenWidgetIds()`） |
| 预设数据 | `src/presets/builtin.ts` | 修改（7 个预设 `ccHidden` 迁 `cc-send-button`；`ccScale` 去 `ekg`；删 55 行随字段下线的死值） |
| 首方 CSS | `…/chat/StatusBar.css`、`…/ControlCenter.css`、`…/solid-workbench/WorkbenchChrome.css` | 修改（`.ekg-*` / `.cc-context-ring` 整组删除；被删 id 的 `[data-widget-id=…]` 死规则删除；`.status-bar button` 等live 规则保留） |
| 契约快照 | `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 修改（**脚本重拍**，非手改；主题字段 200→191） |
| 测试（12 个） | `domains/cc/__tests__/ccLayoutV8.test.ts`、`domains/theme/__tests__/{themeSchemaV8Backfill,migration,presetReducer,presetReducerPureHelpers,themeFieldCopy}.test.ts`、`domains/workbench/__tests__/{selectCcProperties,appearance}.test.ts`、`plugin-runtime/skin/__tests__/skinSchema.test.ts`、`__tests__/{ccHeightState,presets,customPresets}.test.ts` | 修改（断言与夹具同步，逐条见「测试处置」） |
| 渲染侧夹具 / 用例 | `renderers/solid-workbench/__tests__/{mountSolidWorkbench.solid,mountSolidControlCenterPreview.solid}.test.tsx`、`renderers/solid-workbench/__fixtures__/mountSolidControlCenterPreview.solid.tsx`、`sheets/__tests__/AgentSheetView.rendererMode.test.tsx` | 修改（04b：夹具加 `sessionId` 参数、删除 1 条用例、新增 5 条用例） |

**未入库**（本机仓外目录，按规矩不进仓库）：`ekg` 完整实现留档 = `E:\Acode\FILES\任务\预设修正\备份\ekg-留档\`（14 片段 + `索引.md`）；三层备份与 `旧预设清单.md` 同目录；轻量 tag `preset-v1-archive-20260918`（**未 push**）。对应 issue #170。

## 方案要点

**刀4**

1. **删除是「取消现存功能」，不是清理**：`ekgBar` 族里只有 `barHeight` / `barTrackColor` / `barFillColor` / `barFillFollow` 是真失效字段；`ekgGreen` 有真实视觉作用（柱状变体填充色经 `var(--bar-color, var(--ekg-green, …))` 回落链跟随它）。F2 裁决 = 整体删 + 留档，用户已知悉四形态仪表消失。
2. **字段本体必须跟着元件走**：`ccStyle` 与 9 个 ekg/bar 字段在 `themeFieldDefs` / `store` / `presetReducer` / `appearance` / `appearanceStore` / `skinSchema` / `ccHeightState` / `migration` 均有落点。只删元件层会留下 9 个无消费者的设置项，且 §九-2 的「0 残留」验收不可能达标。
3. **★ 版本号坑（静默吃数据）**：`ccLayoutState.ts` 的版本白名单内插常量，常量 8→9 会让白名单变成 `[3,4,5,6,9]`，老 v8 布局**整份回落默认值且不报错**。修法 = 白名单**显式保留 `8`**；同纪律适用于 `migration.ts` 的 10→11（v10 数据必须仍被接受）。已用单测 + 实机 localStorage 种 v8 数据双向锁住。
4. **老数据迁移**：`ccHidden` / `ccScale` / `ccLayout.placements` 三处的 legacy `send` 键迁到注册轨 id `cc-send-button`（只改键名、不改值；`placements` 的别名读取放在 `normalizeCcLayout`，因为该函数是布局归一化的单一入口）。被删的 5 个 id 不写兼容代码，交白名单自然裁掉。
5. **工具栏数据源 = 内置轨 ∪ 占槽位注册轨**：`CC_EDIT_TOOLBAR_IDS = [...CC_WIDGET_IDS, ...CC_REGISTERED_SLOT_IDS]`，其中 `CC_REGISTERED_SLOT_IDS = ['cc-send-button']`。**「基础」`cc-surface` 不进工具栏**——它不开 slot、无 order/offset、无显隐（§三 已拍板 + §六-1），若进工具栏则属性面板会读不存在的 `placements['cc-surface']`；其 6 个值本来就在设置页 › 中控区 › 基础可编辑。**故工具栏是 6 个 chip 而不是 7**（翻译已复核并订正 §九-15 的措辞，用户拍板通过）。
6. **`CcLayoutV3` 类型放宽**：`placements` 的键由 `CcWidgetId` 放宽为 `CcLayoutWidgetId`（内置轨 ∪ 占槽位注册轨），使注册轨 id 可拥有槽位事实。

**04b**

7. **甲 = 隐藏保留**：新增文件级常量 `SHOW_EMPTY_WORKSPACE_CONTROL = false` 守卫两个渲染点；选择器组件本体（`EmptyWorkspaceControl`）、`pickFolder` / `createWorkspace` / 文件夹回调、工作区自动预选逻辑**全部保留**，置 `true` 即恢复（已做可回退性验证：置 true ⇒ `<select aria-label="新会话工作区">` 重现）。
8. **乙 = 沿用单一入口**：空态追加名单收敛为常量 `EMPTY_STATE_HIDDEN_WIDGET_IDS = ['cc-send-button','model','reasoning','mode','tokens']`，只有 `hiddenWidgetIds()` 一个入口。四个状态控件经 `isWidgetVisible` 自动获得 `!edit` 短路 ⇒ 编辑模式豁免（丁）。
9. **★ `sendButtonMode()` 必须补显式 `!ccEditMode` 豁免**：注册轨的发送按钮**不经 `isWidgetVisible`**（它由 `ccSendButtonRegistered() && sendButtonMode()` 门控），没有 `!edit` 短路。故 `sendButtonMode()` 改为读 `hiddenWidgetIds()` 并在编辑态放行。这是对 04b §四-乙「不用另加守卫」口径的**必要补正**（翻译已确认并订正单子）。
10. **戊 在渲染层解决**：实机（cli + peri 空态）实测状态行容器已折叠到 0 高度，**未改 `ccHeightState.ts`**（§二-6 的停手条件未触发）。余下高度属 `--cc-height` 背景板自身，两态一致。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 刀4 §九-2 `ekg` 整体删除 | ✅ 非测试面 grep 仅剩四类必要/报备项（迁移说明与删键清单、v9 注释、`--ekgYellow` 三处按指令只报备、夹具样本值） |
| 刀4 §九-6 待删 id 0 残留（cc 作用域） | ✅ 非测试面 0 命中 |
| 刀4 §九-4 `send` 迁移 | ✅ 单测（`placements` / `ccHidden` / `ccScale` 三处）+ 实机 localStorage：v8 老数据 → `ccHidden ["cc-send-button","tokens"]`、`ccScale {"cc-send-button":120,…}` |
| 刀4 §九-13/14 版本号 | ✅ `CC_LAYOUT_SCHEMA_VERSION = 9` 且白名单显式含 8；`THEME_SCHEMA_VERSION = 11` |
| 刀4 §九-15 工具栏/老布局 | ✅ 实机：6 chip（输入栏/模型/思考强度/权限模式/用量/发送按钮）；v8 布局 model 仍在 `actions`、offset 11/−3 未丢 |
| 04b 甲 | ✅ 实机空态 `workspaceSelector: false`；常量在且置 true 可恢复（红→绿都留证） |
| 04b 乙 | ✅ 实机空态 `widgets ["input"]`、`sendButton false`、`inputBar true` |
| 04b 丙 / 丙-2 | ✅ 新测试断言 `createSession` 实参带 `workspaceId` + `initialPrompt`；零工作区 ⇒ 既有「请先选择工作区」提示、不静默失败 |
| 04b 丁 | ✅ 新测试：空态进编辑模式后 4 控件 + 注册轨发送按钮均可见 |
| 04b 戊 | ✅ 实机 cli+peri 空态：`.cc-footer-status` = 0、三个状态槽位 = 0、无 `.cc-status-row` |
| 非空态对照 | ✅ 实机有会话态：5 控件 + 发送按钮照旧 |
| 门禁四步 | ✅ `build:example-plugin` → `build` → `check:solid` → `test` 全绿 |
| 契约快照 | ✅ 脚本重拍后 `git diff --stat` 与重拍前逐字相同（未误触主题字段/布局） |
| 「不许动」三件 | ✅ `widgetDefinitions.ts` / `ccLayoutState.ts` / `migration.ts` 的 mtime 停在刀4 那轮，内容复查 `CC_WIDGET_IDS` = 5、两个版本号 = 9 / 11 |

## 测试处置

**删（1 条，点名）**：`src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` —— `it('手动选择工作区后，列表更新不会重新套用最近活跃项')`。理由：靠 `fireEvent.change(combobox)` 模拟「手动选择」，选择器隐藏后该交互路径不可达（04b §五-A 表指定处置）。

**改断言（不改被测行为，共 10 条）**：

| 文件 : 用例 | 处置 |
| --- | --- |
| `mountSolidWorkbench` 「update 不重挂 root…」 | combobox `toBeDisabled()` → `queryByRole(...)` 为 null |
| `mountSolidWorkbench` 「空态只有一个工作区时自动选中…」 | 删 combobox 断言，保留 `createSession`（带 `workspaceId` / `initialPrompt`） |
| `mountSolidWorkbench` 「空态有多个工作区时…预选」 | 改由 `createSession` 实参断言预选结果 |
| `mountSolidWorkbench` 「Sidebar 创建会话事件先到达…」 | 同上 |
| `mountSolidWorkbench` 「空态创建失败后保留草稿…」 | 去掉 combobox 断言；标题去掉「与工作区」 |
| `mountSolidWorkbench` 「空态创建期间冻结…」 | 删 combobox 断言，保留 `aria-busy` / pending |
| `mountSolidWorkbench` 「创建后不把模型/模式协商选项…」 | 夹具 `sessionId: null` → `'preview-session'`（意图与空态无关，判定语义未变） |
| `AgentSheetView.rendererMode` 「Solid 工作空态…」 | 删 combobox 断言，保留 `new_session` args 的 `workspaceId` / `cwd` / `skills` / `hooks` |
| `__fixtures__/mountSolidControlCenterPreview.solid.tsx` | 默认夹具改「有会话」并**新增参数** `sessionId?: string\|null`（供空态用例） |
| 刀4 的 12 个测试文件 | 名单/字段/版本相关断言与夹具同步（`ccHeightState` 计数 9→4；最小高 109→84；`selectCcProperties` 键集去 9 项；`skinSchema` 去 `control-center` variant；`ccLayoutV8` 升 v9 并补 v8 不重置 / 非白名单回落；`themeSchemaV8Backfill` 补 v11 迁移用例） |

**新增（5 条）**：

1. `mountSolidWorkbench`：空态极简 —— 只剩输入栏，选择器与 5 控件都不渲染
2. `mountSolidWorkbench`：空态回车仍建会话（贴 `createSession` 实参）
3. `mountSolidWorkbench`：空态 + 编辑模式 ⇒ 4 控件豁免可见、选择器仍不显示
4. `mountSolidWorkbench`：丙-2 零工作区 ⇒ 既有提示、不静默失败
5. `mountSolidControlCenterPreview`：空态发送按钮隐藏 / 编辑模式豁免 / 选择器始终不显示

**反向验证（§七）**：1）空态名单置空 ⇒ 用例 1 红（`expected ['input','model',…] to deeply equal ['input']`）；2）`createEmptySession` 提前 `return false` ⇒ 用例 2 红（`expected [] to deep equally contain {command:'createSession'}`）；3）状态行改 `Show when={!emptyVisual()}` 包裹 ⇒ 用例 3 红（`expected ['input'] to deeply equal ArrayContaining{…}`）。三条均改回后复绿。另做甲的可回退性验证（常量置 true ⇒ `<select aria-label="新会话工作区">` 重现）。

## 证据

- **commit**：无（本片按硬约束未提交；`d2beaf40..<head>` 待提交）
- **测试**（按序，各步退出码 0）：
  - `bun run build:example-plugin` → `[build:example-plugin] dist/entry.js + dist/styles.css + dist/entry.d.ts 已由 src/ 重建`
  - `bun run build` → `✓ built in 14.17s`
  - `bun run check:solid` → `CSS 消费审计通过（注入 115 / 消费 346 / 声明 351，死注入与悬空引用均为 0）`；`ZONE_FIELDS 一致性契约通过（191 个主题字段）`
  - `bun run test` → **Test Files 597 passed (597) · Tests 4316 passed | 2 todo · 0 failed**（刀4 基线 4308 → 本片净 +8：新增 9 / 删除 1）
  - 契约：`bun scripts/check-workbench-theme-contract.mts --write` → `主题字段 191 个；Workbench CSS variables 98`；重拍前后 `git diff --stat` 均为 `33 files, +476 / −1136`
- **残留 grep 两轮**（非测试面）：`ekg|ccStyle|barHeight|barTrackColor|barFillFollow|barFillColor` → 15 命中，全部落在四类必要/报备项；`'session'|'workspace'|'activity'|'tasks'|'ekg'|'send'` → 0 残留
- **真应用（Tauri/WebView2）DOM 检查**：由**翻译**在 04b §十-B 复跑 —— 应用可起、控制台 0 报错、**有会话态** `.cc-status-row` 78.57px 且 `.cc-send-button` 在（非空态无回归）、`[aria-label="新会话工作区"]` 不在 DOM、`--cc-height = 150`。★ **空态在真应用里未能观测**（翻译不擅自增删用户会话），空态实机证据来源 = 本轮浏览器预览实测 + 新增 5 条测试
- **浏览器预览（`http://localhost:5173/`）实测**：空态 = `widgets ["input"]` / `sendButton false` / `workspaceSelector false` / 状态行与三槽位高度 0；有会话态（`ccHidden` 清空）= `widgets ["input","reasoning","mode","tokens","model"]` + 发送按钮在；v8 老数据迁移后 `version 11` / `ccLayout.version 9` / `model placement {actions,9,11,−3}` 未丢。截图落在 `.zcode/cli/artifacts/`（会话级路径，不入库）

## 与 spec 的偏差

1. **字段本体一并删除**（涉 8 个单子未列文件）：不删则 §九-2 的 0 残留无法达标。翻译已接受。
2. **预设数据清理口径**：§五-F 写「只动 `ccHidden` 与 `ccScale`，其余一字不许改」，实际按「**语义**不动」执行——随字段下线的死值（`ccStyle` / `ekgWidth` / 三色 / bar 组）一并清掉，否则 §九-2 的 grep 同样无法达标。翻译接受（实测 `builtin.ts` 净删 65 行，键数口径 27）。
3. **空态工作区选择器保留**（刀4 阶段）：删除 `workspace` 控件会连带打掉「选/建工作区 → 建带 cwd 会话」这条真实链路（8 条既有行为测试）。按「改 A 坏 B = 当场解决耦合」改为宿主渲染元素；后经用户拍板在 04b 里**隐藏**。
4. **工具栏 6 chip ≠ 单子原写 7**：见「方案要点 5」；翻译复核后订正单子措辞。
5. **`sendButtonMode()` 补 `!ccEditMode`**：见「方案要点 9」；翻译确认为必要补正。
6. **多补 2 条测试**（丙-2、丁-发送）：单子只点 3 条，但这两条是 §六 验收项，不锁无证据。
7. **未做**：`AGENTS.md` §2.3 的 `L.md` 声明与 §2.4 开发记录（本轮补，见本文件与 `.agents/L.md`）；`docs/说明书/` 未同步（本刀只动 cc 作用域，说明书未描述中控件清单）。

## 未解问题（遗留待办，累计 10 条）

**刀4（`04` 单 §十二-C）**

1. 夹具样本值仍含 `ekg` / `tasks`（`workbenchSkinContract.ts` 边界值样本、`workbenchFixtures.ts`）—— 非消费者；清理需连带重拍契约快照
2. `skinSchema` 的 `control-center` variant 下线对第三方皮肤的影响（仓库内现无此类皮肤）
3. 「波形与用量」字段组名名实不符（组内只剩「用量胶囊文字 / Prism 已开启状态」）
4. 窄窗「不压扁」只有单测层复核，未做真机窄窗目视
5. `--ekgYellow` 三处引用（`index.css` / `Sidebar.css` / `RuntimeSheetView.tsx`）—— 引用的是已下线语义变量、实际吃兜底色，应改挂正式 token
6. 「可见状态控件上限 4」后中控最小高是否需要重新定档

**04b（`04b` 单 §十-C）**

7. 空态 + 零工作区 ⇒ 提示「请先选择工作区」、原地无新建入口（用户需去侧栏）—— 按用户口径如实保留，是否补原地入口待裁决
8. **视觉终验（用户）**：`http://localhost:5173/` 打开即空态
9. 刀4 侧遗留 6 条 = 上面 1–6
10. `tauri dev` 昨夜自行退出（exit 4）的根因未查（与本次改动无关，退出时间早于 04b 施工）

## 并行交集

**本片碰过的共享文件**（改动**尚未 commit**，请勿改写、勿连带提交）：

- `src/domains/cc/{widgetDefinitions,widgetCatalog}.ts`、`src/ccLayoutState.ts`、`src/ccHeightState.ts`
- `src/domains/theme/{migration,presetReducer}.ts`、`src/themeFieldDefs.ts`、`src/store.ts`
- `src/domains/workbench/{appearance,workbenchAppearanceStore}.ts`、`src/plugin-runtime/skin/skinSchema.ts`
- `src/renderers/solid-workbench/input/ControlCenter.solid.tsx`、`__fixtures__/{workbench-skin-baseline.json,mountSolidControlCenterPreview.solid.tsx}`
- `src/presets/builtin.ts`、`src/plugins/product/packages/builtin.pylon-renderers/styles/components/{chat/StatusBar.css,ControlCenter.css,solid-workbench/WorkbenchChrome.css}`
- 上述区域的 `__tests__`、`src/sheets/__tests__/AgentSheetView.rendererMode.test.tsx`、`.agents/L.md`、本文件

**给后续 agent 的三条提示**：

1. **中控名单已换代**：`CC_WIDGET_IDS` 现在是 5 个（`input`/`model`/`reasoning`/`mode`/`tokens`），可落槽控件还要加上注册轨的 `cc-send-button`（`CC_REGISTERED_SLOT_IDS`）；`ekg` / `session` / `workspace` / `activity` / `tasks` 已不存在，旧代码里对它们的引用会静默失效。
2. **改布局/主题 schema 必看白名单**：`ccLayoutState.ts` 的版本数组必须**显式保留**历史版本（当前 `[3,4,5,6,8,CC_LAYOUT_SCHEMA_VERSION]`），否则老用户布局静默回落默认值。
3. **空态可见性只有一个入口**：`hiddenWidgetIds()`（含 `EMPTY_STATE_HIDDEN_WIDGET_IDS`）。新增控件若要参与空态收敛，请走这个入口；注册轨控件（不走 `isWidgetVisible`）需自行补编辑态豁免，参考 `sendButtonMode()`。
