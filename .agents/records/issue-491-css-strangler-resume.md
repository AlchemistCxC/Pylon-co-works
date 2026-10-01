# Dev Record — #491 CSS 策略翻转 → 绞杀恢复批（首刀）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-491-css-strangler-resume.md`

## 元信息

- issue：[#491](https://github.com/Teens-in-Times/Pylon-co-works/issues/491)（enhancement(styles)，已认领 AlchemistCxC）
- 分支：`kumo/491-css-strangler`（独立 worktree `G:/Project/prism-team-workdir/pylon-491`，共享树让给 #488-②）
- 提交范围：`ea82ac88..c9d632ec`（基线 github/main）
- 日期：2026-10-01

## 目标与范围

**裁决**：用户推翻 issue #491 正文维护者裁决「只 Tailwind 化必要的内容，存量不主动迁移」，改为**绞杀式主动迁移**，边界：**保留复杂组件和功能，只迁移结构简单、耦合度低的**。本批交付三件事：

1. 策略条文改写（dev-standards 样式节第一条，「存量不迁移」→「绞杀式主动迁移」+ 四条判据）；
2. 恢复 P93/J 施工书绞杀流水线，执行首刀：现存 CSS 中唯一满足整文件绞杀判据的 `SkinPreviewBar.css`；
3. 全量 triage 表（本记录），作为后续批次与「功能性触碰顺手迁移」的判定底账。

**不做什么**：不碰任何复杂/高耦合资产（triage 见下）；不碰维护地图（#489 在途声明其门禁行域，本批策略落点按 issue 条文 4 的「或 dev-standards 样式节」选项）；零 Rust 改动（check:rust/check:clippy 不在本批门禁面）。

## 绞杀判据（整文件可绞杀的充分条件，全部满足才动）

1. **消费面单一**：类只被一个组件文件（或单封闭组件组）消费；
2. **无跨文件级联/特异度博弈**：不参与与他文件同 specificity 的加载序竞争；
3. **无条件规则**：无 scheme/mode/媒体查询/动效/`:has()`（utilities 表达不了，且 `dark:` 禁用）；
4. **无 color-mix 组合色**（dev-standards 禁止 TS 类串新写 color-mix/字面量色值）。

## 全量 triage（main 面 21 个第一方 CSS，绞杀路线图底账）

| 文件 | 行数 | 处置 | 理由（判据编号=不满足项） |
| --- | --- | --- | --- |
| `components/kernel/SkinPreviewBar.css` | 59 | **本批绞杀** | 唯一全过：kernel 单组件、命名空间自包含 |
| `…renderers/…/chat/ChatView.css` | 2522 | 留守挂账 | issue 点名；mode/皮肤条件面 |
| `…shell/…/Settings.css` | 1584 | 留守 | 复杂组件；settings 面板群共享词汇多 |
| `…workspace/…/sheets/file/FileSheet.css` | 1208 | 留守 | file 域内部（tree/tab/CodeMirror/git）复杂面 |
| `…shell/styles/App.css` | 925 | 留守 | 标题栏/窗口控制壳层 chrome，`-webkit-app-region` 拖拽区 utilities 不宜表达 |
| `…renderers/…/solid-workbench/WorkbenchChrome.css` | 704 | 留守 | #266/#410/#412 近期重设计域；suite 挂载几何 |
| `…workspace/…/Sidebar.css` | 674 | 留守 | #410 重设计域 |
| `…renderers/…/ControlCenter.css` | 392 | 留守 | #266 刀5/#410 域，中控槽位几何 |
| `…workspace/…/right-panel/ContextPanel.css` | 189 | 留守 | 3 不满足：过半 terminal-like mode 块；::before 背景合成消费 `--right-*` 运行时变量 |
| `…shell/…/SettingsCommon.css` | 132 | 留守 | 1 不满足：`settings-*` 控件基线 + dialog 基线被 Settings.css 及多面板共享 |
| `…workspace/…/sheets/OverviewSheetView.css` | 125 | 留守 | 3、4 不满足：modern-gui/tactical-blue mode 皮（大量字面量色）+ keyframes + reduced-motion |
| `…renderers/…/chat/InputBar.css` | 230 | 留守 | #410 重设计域 |
| `…shell/…/SessionSettings.css` | 47 | 留守 | 1、3 不满足：`sess-*` 词汇被 App/Sidebar/SessionsPanel/settings 面板/AgentSheetView 多消费 + 2 个 CSS 契约测试钉住 + 暗 scheme 变量块 |
| `…renderers/…/chat/StatusBar.css` | 20 | 留守 | 2 不满足：`[data-mode]` 语义色依赖槽位前缀与 WorkbenchChrome.css 的特异度/加载序博弈（2026-09-23 修），进 utilities 层必输给未分层规则——**小≠可绞杀的实证样本** |
| `smoke/solidWorkbenchSmoke.css` | 12 | 留守 | smoke 入口不加载 tailwind.css，绞杀即裸奔（smoke-only 隔离是制度设计） |
| `index.css` | 398 | 制度保留 | token 源 + @layer base/层序声明 + Recovery 基线 |
| `adaptive.css` ×3 | 60/22/11 | 制度保留 | 每包唯一合法自适应残量（mode/媒体/动效/`:has()` 专用） |
| `SheetVocabulary.css` | 60 | 制度保留 | shared 底座豁免（跨 sheet 共享词汇基线，issue #83） |
| `styles/tailwind.css` | 103 | 制度保留 | utilities 唯一入口 |

**第二批候选（登记未施工）**：① SettingsCommon 的 `dialog-*` 基线组——3 个消费组件（PermissionDialog/SessionSettings/SessionsPanel）+ 暗 scheme `--dialog-bg` 字面量需先立 shell 包 adaptive.css 承接；② SessionSettings 拆分路径——布局类 utilities 化 + scheme 块入 shell adaptive.css，前置是多消费面收拢。两件的触发时机：功能性触碰该域时，或后续专项批次。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/components/kernel/SkinPreviewBar.tsx` | 样式全 utilities 化；根保留 `skin-preview-bar` 零规则锚点类；3 个按钮显式类串 | 修改 |
| `src/components/kernel/SkinPreviewBar.css` | 整文件 | **删除** |
| `src/plugins/product/firstPartyStyleOwnership.ts` | 删 SkinPreviewBar.css 登记行（附绞杀批注） | 修改 |
| `src/plugins/product/__tests__/firstPartyStyleOwnership.test.ts` | expectedCssPaths 与 kernel 列表同步注销 | 修改 |
| `.agents/dev-standards.md` | 样式节第一条策略条文改写 | 修改 |

## 方案要点（忠实性映射，delta 全录）

| 原值 | 迁后 | delta |
| --- | --- | --- |
| `background: var(--settings-surface, rgba(255,255,255,0.96))` | `bg-surface-overlay` | 原 fallback 白底在 KernelRoot 挂载域**无定义恒生效**（暗色下刺目=既有视觉缺陷）；改公开角色 token 跟随 scheme，**顺带修复** |
| `box-shadow: 0 8px 24px rgba(0,0,0,0.18)` | `shadow-[var(--shadow-soft)]`（0 8px 28px 13%） | 同族微差，token 化（shadow 命名空间不映射，按规走任意值语法） |
| `[data-valid]` 色 `#ff6b80`/`#4eba65` | `data-[valid=…]:text-danger`/`text-success` | 语义 token 色相随主题 |
| input/button 边框 `rgba(0,0,0,0.18)` | `border-stroke-subtle` | token 化，与 settings 控件族一致 |
| commit 按钮 `border-color: var(--accent) !important` | `border-accent` | 去 `!important`：原为压 `.skin-preview-bar button` 元素规则，类串单源后无竞争，计算样式不变 |
| 定位/间距/圆角/字号/行高/等宽 | 逐值等映射（bottom-4/gap-2/px-3 py-2/rounded-[10px]/text-sm/leading-[1.4]/font-mono/text-xs 等） | 无 |

其余决策：根类 `skin-preview-bar` 保留为**零规则锚点**（`SkinPreviewBar.test.tsx` 三处 `querySelector('.skin-preview-bar')` 契约不动，diff 最小）；层叠风险面核过——该组件挂 KernelRoot 顶层，首方 CSS 无裸元素选择器能命中其内部（plugin CSS 皆类作用域，index.css 元素 reset 在 @layer base 低于 utilities）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `check:first-party-styles` | ✅ 21 files（kernel: 3→2） |
| `check:tailwind-tokens` | ✅ 104 行无字面量色值 |
| `bun run lint` | ✅ 0 error（1 条 pre-existing warning，位于本批未触碰文件） |
| 全量 vitest | ✅ 662 文件：5172 passed / 0 failed（1 skipped、1 todo）；唯一一度红灯是 worktree 未构建 example 插件产物的环境问题，`build:example-plugin` 后 7/7 过 |
| `bun run build` + 产物核查 | ✅ `.z-\[1000\]{z-index:1000}`、`--tw-leading:1.4`、`.data-\[valid\=invalid\]\:text-danger[data-valid=invalid]{color:var(--danger)}` 等全部生成 |
| `bun run check:frontend:static` 全链 | ✅ EXIT=0（CSP/canonical/retention/sanitize/ipc/ownership/tokens/example-plugin/wasm/build/bundle/solid-smoke/docs/deps/production-excludes）；bundle 预算 1,517,101 / 1,615,000 gzip 通过 |
| check:rust / check:clippy | 不适用（零 Rust 触碰） |

## 测试处置

- 修改 `firstPartyStyleOwnership.test.ts`：两处清单钉点随契约注销（契约变更：SkinPreviewBar.css 不再登记）；断言形态不变。
- `SkinPreviewBar.test.tsx` **零改动**全绿——锚点类保留使查询契约稳定。
- 未新增测试：绞杀是等价迁移，钉面由既有 ownership 测试与构建产物核查承接。

## 验证限制与遗留

- **真机复验未做**：skin 预览激活路径需经 Skin Runtime 人工作业（draft→preview），无现成 UI 入口；delta 已在上表全录且构建产物核查覆盖选择器生成。若用户在实机发现 bar 外观差异，按映射表回溯。
- 首刀仅 1 文件 59 行——这是判据**本来的样子**：21 文件里 20 个因复杂或耦合留守。绞杀的推进模式是「功能性触碰时顺手迁被触碰块」+「第二批候选专项」，不为迁移而迁移的底线仍在，只是从「完全不迁」翻转为「按判据主动吃」。
- issue #491 不由本批自动关闭判据外的内容担保：策略条文（交付 4）与门禁绿（验收 1）已交付；「抽查功能性触碰 PR」属后续持续验收。
