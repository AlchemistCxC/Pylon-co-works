# Dev Record — #266 刀5 编辑清单改左侧一列 + 拖动阈值

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 施工单：`E:\Acode\FILES\任务\工作台优化\待办\12-施工单-编辑清单改左侧一列与拖动阈值（刀5）.md`

## 元信息

- issue：#266（中控遗留总账 · 本刀不开新 issue）
- 分支：`feat/cc-visibility-two-layer.5`（基于 `origin/main @ 10834c75`，建后已 `--unset-upstream`）
- 提交范围：`10834c75..<交付态>`（施工期不 commit，由翻译收口存档）
- 日期：2026-09-30

## 目标与范围

**做**：① 编辑态拖拽加 3px 位移阈值（"点一下只选中、不挪件、不标自定义"）；② 编辑清单从底部横栏搬成**左侧一列**（一列到底、行内展开、行内两个开关、列底重置/退出）；③ 列跟随编辑态显示（含空态）；④ 连带复核双向对应与刀4 两条。

**不做**：悬停高亮、自动滚动、位置模型（`layout`/`detachX`/槽位）、尺寸算式、出厂数据值、`THEME_SCHEMA_VERSION`、刀4 校验口径、`.cc-edit-hdr` 在空态的显示（空态几何另一套规则）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | 新增 `CC_DRAG_THRESHOLD_PX` + `beginDrag` 阈值；删属性面板/底部工具栏两族 DOM，新增左列；**根节点改 fragment** | 修改 |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css` | 删 `.cc-edit-toolbar*` / `.cc-prop-panel,-header,-body,-footer`；新增 `.cc-edit-column*` / `.cc-edit-row*`；`.cc-edit-warning` 改列内布局 | 修改 |
| `.../styles/components/solid-workbench/WorkbenchChrome.css` | 空态隐藏列表删 `.cc-edit-toolbar` / `.cc-prop-panel` 两条 | 修改 |
| `src/renderers/solid-workbench/__tests__/mountSolidControlCenterPreview.solid.test.tsx` | 换选择器 + 作用域改 `host`；新增 5 条用例 | 修改 |
| `src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` | 工具栏 role 断言 → 左列 group；`.cc-prop-panel` → `.cc-edit-row-props` | 修改 |
| `src/renderers/solid-workbench/__tests__/workbenchChromeCss.solid.test.ts` | 正控指向换类；新增空态 CSS 守卫 | 修改 |

## 方案要点

### 1. ★ 左列渲染在**中控槽位之外**（本刀唯一的方案偏离，必须留痕）

施工单 §四 C1 的机制是"去掉空态那两条 `display:none`，列就在空态显示"，其前提是列是槽位**后代**。实核发现该前提不成立：

- 空态那条 `.solid-workbench-control-center-slot.is-empty { transform: translateY(-50%) }` 会给 `position:fixed` 的后代**建立包含块**（CSS Transforms 规范）。
- 槽位自身就是被变换的元素 ⇒ 列若渲染在槽位内，`fixed` 会相对"中控那一条带"定位：空态槽位高仅 96px ⇒ 列会被压成 `96-32=64px` 高、且跟着槽位的 `-50%` 位移走（实测：不脱出时会落在槽位附近，而不是视口）。
- 若改去动空态几何（把 `translateY(-50%)` 换成 auto 外边距等），就违反 §十.1"只动那两条"。

**处置**：组件根由单个槽位 div 改成 **fragment**——槽位原样返回，左列作为其**兄弟**渲染。槽位的类名/`data-*`/内联变量/几何一个字节未动；列则在两个状态下都是**视口定位**（实测常态与空态都是 `0,32 280×768`，正好 `top:32 / bottom:0`）。

### 2. 拖动阈值（3px，直线距离）

`beginDrag` 里按下仍立即 `setSelected`（选中语义不变），但**记起点后不立刻拖**：`pointermove` 累计到 `Math.hypot(dx,dy) >= 3` 才第一次 `updatePlacement`。判定是"**越过阈值即进拖拽**"而不是"等 pointerup 才判"，否则"按下后拖 30px 再松开"整段作废。

3px 的依据：① 翻译定值（施工单 §四 A1、§二.4）；② 实数取舍——指针按下的自然抖动约 1–2px，3px 能盖住抖动而肉眼仍觉"贴合"；③ 与"点一下只选中"这条用户口径的最小可分辨位移一致。实机复核：微动 2px 时输入栏 inline `transform` 为空、`getBoundingClientRect` 逐像素不变、持久化数据逐字节未变。

### 3. 行内展开的互斥口径

展开态 = **`selected()` 那一份真值**（不新造第二个状态）：`<Show when={selected() === id}>`。点行名 ⇒ 选中并展开；点另一行 ⇒ 换过去；再点同一行 ⇒ `setSelected(undefined)` 收起（同时清掉画布描边与常驻提示，均为既有语义）。因此"同一时刻只有一行展开"是**结构保证**，不是靠额外互斥代码。

### 4. 空态显示列 + 只在编辑态出现的连带

列的作用域只认 `ccEditMode`，与空态无关 ⇒ 空态下进编辑器同样在。改造前那两条空态隐藏规则点名的类（`.cc-edit-toolbar` / `.cc-prop-panel`）已随两族 DOM 删除 ⇒ 规则整条收敛为"空态只隐藏 `.cc-bg` 与 `.cc-edit-hdr`"。`.cc-edit-hdr` 在空态仍不显示（本刀故意不动）。

### 5. 一处退出

改造前有两处退出（属性面板 footer 的「退出自定义」+ 工具栏的「退出编辑」）。左列列底只留「退出编辑」（`aria-label="退出中控编辑"` 沿用，挂在既有测试的锚点上）。实机全文档 `button` 文本含"退出"者 **恰好 1 个**。

## 验收标准与结果

### 门禁与契约（本机实测）

| 项 | 结果 |
| --- | --- |
| `bun run lint` | exit 0（0 error / 1 warning，`GatewaySheetView.tsx` 存量、非本单文件） |
| `bun run build:example-plugin` | exit 0 |
| `bun run build` | exit 0（tsc -b + vite） |
| `bun run check:solid` | exit 0 |
| `bun run test` | exit 0：**663 文件通过 / 1 skipped**；**5163 用例通过 / 1 skipped / 1 todo** |
| `bun run check:clippy` | exit 0，各 crate `added: []` |
| 契约快照 | `themeSettingCount` = **177**；`--write` 后仅 `generatedAt` 变（已拷回原文件，sha1 `89e5c35c…` 复原） |

### 实机（WebView2，debug 构建，`--remote-debugging-port=9222`）

先自检链路与产物：`typeof __TAURI_INTERNALS__.invoke === 'function'`；CSSOM 里 `.cc-edit-column`（`position:fixed;left:0;top:32px;bottom:0;width:280px`）在、`.cc-edit-toolbar` / `.cc-prop-panel` 已不在、空态无隐藏列的规则。

| # | 读数 | 数值证据 |
| --- | --- | --- |
| 1 | 编辑态（常态）左列在 | 全文档**恰好 1 个** `.cc-edit-column`；rect `x0 y32 280×768`（视口 1200×800 ⇒ 正好 `top:32 / bottom:0`）；列头「中控元件」；`role=group`，**无** `role="toolbar"`；列表 `overflow-y:auto` |
| 2 | 行与开关齐 | **7 行**（`input`●、`model`●、`reasoning`●、`mode`●、`tokens`●、`cc-command-hint`●、`cc-send-button` ＋/dim）；每行两个开关（文本 `隐藏/显示` 与 `空态里再藏/空态放出` 各按自己那份表翻转） |
| 3 | 行内展开正确 | 点「模型 属性」⇒ 该行就地撑开（行高 34→510，后续行下移）；展开区三个布局格 = **顺序 2 / 水平 0 / 垂直 0**，与持久化 `ccLayout.placements.model` 一致 |
| 4 | 展开互斥 | 展开「模型」后再点「思考强度」⇒ 展开区**恰好 1 个**且 `aria-label="思考强度 属性"`；再点同一行 ⇒ 0 个 |
| 5 | 两个开关可用且各写各表 | 常态点「隐藏 模型」⇒ `ccHidden` 增 `model`、画布上 model 消失、`--cc-min-height` 85→**64**；空态点「空态放出 模型」⇒ `ccHiddenEmpty` 少 `model`、`ccHidden` 一字未动、model 出现在画布，行内标记 `＋`→`●` |
| 6 | 重置/退出在位 + 只有一处退出 | 列底 `↺ 重置位置` + `退出编辑`；全文档"退出"按钮 **恰好 1 个**（`aria-label="退出中控编辑"`），无"退出自定义"；点重置 ⇒ 全部 offset 归 0、输入栏 inline `transform` 变空、rect 回到 `375,384` |
| 7 | 拖动阈值（阈值内） | 按下 + 移动 **2px** + 松开：持久化 `placements / ccHidden / ccHiddenEmpty` 与操作前**逐字节相同**（`byteIdentical: true`）、输入栏 `transform` 为空、rect 未动；同时该行 `active` + 展开、画布件带 `.cc-selected` |
| 8 | 拖动阈值（越阈值） | 拖动到 `(+20,-8)`：位移 = 与起点差 `translate(20px,-8px)`、rect `375,384`→`395,376`；展开区「水平 20 / 垂直 -8」同步；落盘 `placements.input = {offsetX:20, offsetY:-8}` |
| 9 | 双向对应 | 点行 ⇒ 画布件描边（`.cc-widget.cc-selected[data-widget-id=input]`，`outline:2px solid rgb(99,102,241)`）；点画布件 ⇒ 对应行 `active`+展开+属性值正确 |
| 10 | 编辑态（空态）★ 核心判据 | 空态 + 编辑态：左列**同样在**（`x0 y32 280×768`，7 行，两个开关与列底两按钮齐）；空态画布未被压坏——槽位仍在 `250,374 950×96`，中心 y = 422 = 44 + (800-44)/2，与"舞台上居中"算式逐像素一致 |
| 11 | 被拒提示在列内 | 压低高度到 66px 后点「显示 模型」⇒ 列内出现 `role="alert"` 提示「还差 19px：需要 85px，当前 66px —— 先加高，或先藏别的」（rect `12,703 255×45`，`column.contains(warning) === true`）；同时**数据逐字节未变**；加高回 96px ⇒ 提示自行退场、再点即成功（`ccHidden` 回到 `["cc-send-button"]`） |
| 12 | 窄窗 | `Emulation.setDeviceMetricsOverride` 520×700：列仍 `280×668`（`top:32 / bottom:0`）、无横向溢出（列 `scrollWidth == clientWidth`、文档不横向滚）、列表 `scrollHeight 617 > clientHeight 570` **可纵向滚**、每行单行 33px 高、开关宽度不被压缩（34/54/64px） |

### 数据三件事（施工单 §八.4 尾条）

1. **先备份**：`%APPDATA%\com.prism.desktop` + `%LOCALAPPDATA%\com.prism.desktop` → 仓外 `报告等\12-…\数据备份-20260930\`（179M + 347K）。
2. **验后逐字节还原**：`diff -r` 两棵树 `EXIT=0`（无差异）。
3. **冷启动复读一致**：重启后读回 `ccHeight 96`、`ccHidden ["cc-send-button"]`、`ccHiddenEmpty` 6 件（含 model）、`custom.cc true`、`placements.input.order 0`、`placements["cc-command-hint"].order 5` ⋯ 与验收前一致；随后再还原一次（冷启动自身会刷新 WebView2 缓存与 `-wal/-shm`），再次 `diff -r EXIT=0`。

## 测试处置

**修改的既有行为测试（逐个点名）**：

| 文件 | 用例 | 改了什么 |
| --- | --- | --- |
| `mountSolidControlCenterPreview.solid.test.tsx` | `04b 空态极简…` | `.cc-edit-toolbar` → `.cc-edit-column`，作用域 `controlCenter` → `host` |
| 同上 | `刀1：编辑态下被预设 ccHidden 藏起来的发送按钮不在场` | 同上 |
| 同上 | `刀1：清单是隐藏件唯一入口…` | `.cc-edit-toolbar-chip-wrap`→`.cc-edit-row`、`.cc-edit-toolbar-chip`→`.cc-edit-row-name`、`.cc-edit-toolbar`→`.cc-edit-column`，作用域改 `host`；**断言口径不放宽** |
| 同上 | `CC-02 第 5 步收口：工具栏那一格与控件同源…` | 选择器与作用域同上 |
| 同上 | `刀4 显示前校验：装不下 ⇒ 不发命令…` | 判据行 `[role="toolbar"] .cc-edit-warning` 为空 → 改为「提示必须落在 `.cc-edit-column` 内」（仍**不允许**进 toolbar 语义），作用域改 `host` |
| 同上 | `刀4 两个开关各写各表（DOM 读数）…` | 选择器 `.cc-edit-toolbar-chip-wrap`→`.cc-edit-row`；删掉一行已不再使用的 `controlCenter` 绑定（改为存在性前置断言，避免 TS6133） |
| `mountSolidWorkbench.solid.test.tsx` | `空态…只有 input` 正控（1470 附近） | `findByRole('toolbar', {name:'中控控件工具栏'})` → `findByRole('group', {name:'中控元件'})` |
| 同上 | `中控编辑工具栏可隐藏、恢复、重置并退出` | 标题改「中控编辑**左列**…」；首尾两条 toolbar role 断言换 group（行为断言原样） |
| 同上 | `#266 · 输入栏属性面板：字段恒定…` | `panel()` 选择器 `.cc-prop-panel` → `.cc-edit-row-props`；字段断言原样 |
| `workbenchChromeCss.solid.test.ts` | `刀2.5 下边组不折行…` 的正控 | 原正控指向 `.cc-edit-toolbar`（该类已删）→ 改指 `.cc-edit-row-main` 与 `.cc-edit-column-footer`，口径不变（证明上条断言非空断言） |

**未改动、仍绿**（施工单 §六点名者）：`ccHeightState.test.ts`、`ccShowVerdict.test.ts`、`ccVisibilitySliceGuard`、`ccPrunedFieldsGuard`、`ccDeadDataGuard`、`ccVisibilityDeclarationGuard`、`widgetDefinitionTable.test.ts`、`appearance.test.ts`、`zustandWorkbenchAppearanceStore.test.ts` —— 全量套件里一并通过。

**新增用例（5 条，均在 `mountSolidControlCenterPreview.solid.test.tsx`）**：

1. `刀5 拖动阈值：按下后微动 2px 松开 ⇒ 件不挪（零位移写入）、该区不被标自定义，但选中照旧生效`
2. `刀5 拖动阈值：移动 ≥3px ⇒ 位移正确（与起点差一致）`
3. `刀5 行内展开互斥：展开 A 后点 B ⇒ 只有 B 展开；再点 B ⇒ 收起`
4. `刀5 空态 + 编辑态：左列同样在、行数与开关齐（空态下够得着编辑器）`
5. `刀5 退出编辑只剩一处（列底那枚；属性面板那个「退出自定义」已删）`

另有 1 条 **CSS 侧守卫**（`workbenchChromeCss.solid.test.ts`）：`#266 刀5 · 空态只隐藏背景板与高度手柄，不隐藏编辑左列`。

**反向验证（3 轮，先自留副本 → 打坏 → 变红 → 拷回副本 → 核 sha1）**：

| 轮 | 打坏内容 | 结果 |
| --- | --- | --- |
| ① | 去掉阈值（回到"按下即拖"） | 只红那两条阈值用例；`AssertionError: 阈值内松开：一次 update-cc-placement 都不许发: expected [ { …(3) } ] to have a length of +0 but got 1` / `expected { order: 2, offsetX: 2, offsetY: +0 } to match object { offsetX: +0, offsetY: +0 }`；还原后 sha1 `90027a3e…` |
| ② | 展开不互斥（`when={selected()===id}` → `when={true}`） | 只红互斥用例；`expected [ '输入栏 属性','模型 属性','思考强度 属性', …(4) ] to deeply equal [ '模型 属性' ]`；还原后 sha1 同上 |
| ③ | 把空态隐藏**加回来**（按新类名 `.is-empty .cc-edit-column/.cc-edit-row{display:none}`） | 红在 CSS 守卫：`空态不得隐藏编辑 UI：.solid-workbench-control-center-slot.is-empty .cc-edit-column: expected … not to match /cc-edit-column\|…/`；还原后 hash 与交付态一致 `7f969e02…` |

## 遗留 / 与施工单的偏差（需翻译裁断或登记）

1. **★ 左列渲染在槽位之外**（见「方案要点 1」）：机制与施工单 §四 C1 的描述不同，但满足其括注目标（空态也显示）且不动空态几何。若不接受，替代方案只有改空态 `transform` 表达（会触及 §十.1 禁止的几何规则）。
2. **反向验证 ③ 的"红"落在 CSS 守卫上**：jsdom 不加载样式表，所以"空态可视"这件事在 DOM 用例里看不见，只能由读 CSS 文本的守卫承担；空态 DOM 用例本身覆盖的是"渲染条件只认编辑态"。两条合起来才是施工单 §六"空态编辑态：左列在（DOM 存在且可见）"的完整落点。
3. **施工单写"8 行元件齐"，实为 7 行**：行 = `CC_WIDGET_IDS`(6) ∪ `CC_REGISTERED_SLOT_IDS`(1)，由定义表派生（`cc-surface` 不占槽故不入列）。用例按 7 断言。
4. **单测里的"不标 custom"用等价判据**：预览走的是静态外观表，快照不携带 `custom`（置位在 zustand `themeStore.updateCcPlacement`）⇒ 用例断言"一条 `update-cc-placement` 都不发"（`markZoneCustom` 的唯一触发点）；真值 `custom.cc` 由实机读数承担（本机验收前该区已是 `custom.cc=true`，无法观测 false→false 的"未置位"跃迁，故实机以"持久化数据逐字节未变 + 件不动"作判据）。
5. **窄窗用 `Emulation.setDeviceMetricsOverride`**（视口 520×700），不是真实拖 OS 窗口边框；列是固定 280px，与窗口宽度无耦合，等效。
6. **编辑态下侧栏与聊天区 `pointer-events:none`**（既有行为，非本刀引入）：这在实机里挡住"编辑态下切页签/点会话"，要换会话须先退出编辑态。已记录，未改。
7. **报告与数据备份在仓外**：`E:\Acode\FILES\任务\工作台优化\报告等\12-施工单-编辑清单改左侧一列与拖动阈值（刀5）\`（含逐条证据、反向验证红段日志、数据备份）。完工清目录时备份可一并清掉（数据已还原）。

## 证据

完整命令与原始输出落仓外报告目录（`报告等\12-…\`）：

- `2026-09-30-工作者汇报.md`：门禁逐步输出、反向验证三轮红段、实机读数与复现命令
- `反向验证副本\轮{1,2,3}-红.log`：三轮红段原样日志
- `反向验证副本\ControlCenter.solid.tsx.交付态` / `WorkbenchChrome.css.交付态`：自留副本（sha1 对账用）
- `数据备份-20260930\`：验收前数据副本（已 `diff -r` 复核还原一致）

关键命令（复现用）：

```bash
# 门禁（顺序不可跳步）
bun run lint && bun run build:example-plugin && bun run build && bun run check:solid && bun run test && bun run check:clippy

# 契约快照（--write 后只应 generatedAt 变，随后还原）
bun scripts/check-workbench-theme-contract.mts

# 实机（调试端口已内嵌进 tauri.conf.json；前端改动必须重编 Rust）
bun run build && cargo build --manifest-path src-tauri/Cargo.toml && ./src-tauri/target/debug/pylon.exe
```
