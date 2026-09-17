# Dev Record — #116 外观与设置页排查整合 10 项

> 规格文档 `.agents/spec/116-frontend-audit.md` 不入库；其目标、范围、方案与验收结论在本文件承接。

## 元信息

- issue：[#116](https://github.com/AlchemistCxC/Pylon-co-works/issues/116)（整合已关闭的 #112 / #113 / #114 / #115 / #128）
- 分支：`Ru5t/Reflector`
- 提交范围：`67e7165c..<head>`（`67e7165c` 为本轮开工前的 main 合并点）
- 日期：2026-09-17
- 施工手段：源码 + `tools/webview2-mcp`（WebView2 CDP）实机核验，基准实例 `F:\A-I\Platform\Pylon\pylon.exe`

## 目标与范围

修复两轮 CDP 排查中确认为**前端缺陷且不涉及设计决策**的 10 类问题：间距工具类全系失效（根因）、三 sheet 未撑满、Runtime 来源列断行、界面英文残留、渲染器字段行横向溢出、模板库卡片死空间、预设裸漏内部 ID、实时预览栏挤压、破坏性操作无确认、探测错误串裸漏。

**不做什么**（照 spec 边界执行）：

- 中控区（ControlCenter 及其状态条 / 状态胶囊）一行未碰——本轮把它当作回归对照面而非修改对象（见「统一回归项」）。
- 子项 10 只改错误的**呈现方式**，不动 `version_probe` 的判定算法（属 Rust 域）。
- 不做图标体系、选中态对比度、上下文面板空态、会话原始 ID、`stderr` 徽标列起点等审美/排版决策项。
- 不引入 i18n 框架，不合并 `utils.formatTime` 与 `OverviewSheetView.relativeTime` 两处实现（仅统一口径）。

**用户口径修正（本轮中途）**：英文残留不必「全盘去英文」，只去**突兀**的——同一处并列文案里口径冲突、或内部标识泄漏。据此保留 `Base URL` / `API Key` / `Temperature` / `Top P` / `Seed` 这类行业专名（改为「中文名（专名）」的括注形式），只清理确实刺眼的项（见子项 4）。`Endpoint 路径`、`最大输出 Token` 这类中英拼接与「同页两套口径」的才是整改对象。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/index.css` | 顶部声明层序 + reset 移入 `@layer base` | 修改 |
| `src/styles/tailwind.css` | 头部不变量注释补 reset 所在层 | 修改 |
| `builtin.pylon-workspace/styles/components/PrismSheet.css` | 新增 `.sheet-tool-view` 拉伸 flex 容器 | 修改 |
| `builtin.pylon-shell/styles/components/Settings.css` | `.renderer-number-duo` 去 display / 新增组合类 flex 契约 / 新增预览栏折叠与 `.set-confirm` / `.template-preview` 去 transform 缩放 | 修改 |
| `src/sheets/search/SearchSheetView.tsx` | `SHEET` 常量补 `flex-1` | 修改 |
| `src/sheets/history/HistorySheetView.tsx` | 同上 | 修改 |
| `src/sheets/RuntimeSheetView.tsx` | 来源列补 `whitespace-nowrap` | 修改 |
| `src/sheets/browser/BrowserSheetView.tsx` | 新增 `BROWSER_PHASE_LABELS`，状态词与侧栏注记中文化 | 修改 |
| `src/utils.ts` | `formatTime` 三个英文分档改中文 | 修改 |
| `src/components/Sidebar.tsx` | 头像编辑按钮 title 中文化 | 修改 |
| `src/presets.ts` | 新增 `fallbackPresetChip`（兜底 chip 判据） | 修改 |
| `src/settingsDomains.ts` | 新增 `SECTION_OWNER_LABELS` | 修改 |
| `src/components/settings/SettingsSectionHeader.tsx` | Owner 头显示可读名（id 落 `data-owner`） | 修改 |
| `src/components/settings/InputPredictionSettingsPanel.tsx` | 6 个字段标签改「中文名（专名）」 | 修改 |
| `src/components/settings/settingsChromeState.ts` | 新增预览栏折叠态读写 | 修改 |
| `src/components/Settings.tsx` | 预览栏折叠 + 两处二次确认 + 兜底 chip 接线 | 修改 |
| `src/components/SettingsPreview.tsx` | caption 标注为示意（含缩放比例） | 修改 |
| `src/components/settings/agentDetectionDiagnostics.ts` | **新增**：诊断呈现口径 | 新增 |
| `src/components/settings/AgentRuntimePanel.tsx` | 诊断渲染改用呈现口径 + 原文进运行日志 | 修改 |
| `src/plugins/core/interfaceMode/builtinInterfaceModes.ts` | `Terminal-like` → 「经典终端」 | 修改 |
| `builtin.pylon-plugin-manager/panel/pluginManagerPanel.ts` | 新增 `BOOTSTRAP_STATE_LABELS` | 修改 |
| 各处 `__tests__` | 见「测试处置」 | 修改 / 新增 |
| `.agents/decisions/0007-global-reset-layer.md` | reset 落层的 ADR | 新增 |
| `.agents/dev-standards.md` | 样式节补「该约定只对存量类成立」 | 修改 |
| `.agents/L.md` | #116 文件域声明 | 修改 |

## 方案要点

1. **间距工具类（根因）**：把 `src/index.css` 的全局 reset 原样移入 `@layer base` 并在同文件显式声明层序 `@layer base, theme, utilities;`。相对优先级固定为 `未分层第一方 CSS > utilities > base(reset) > UA`——存量类的既有约定不变，`box-sizing: border-box` 的生效范围不变，只是 utility 不再被元素级 reset 恒压。详见 ADR-0007。
2. **三 sheet 撑满**：`.layout` 是 flex 容器，Search / History 根元素缺 `flex-grow`（实测 `flex: 0 1 auto`），补 `flex-1`；Prism 的 `.sheet-tool-view` 是 `display:block`，其内 `.prism-sheet` 的 `flex:1` 无从生效，改为拉伸的 flex 容器（`.sheet-tool-view` 全仓只有 Prism 一个消费者，已 grep 确认）。
3. **来源列**：补 `whitespace-nowrap`（与同文件 `runtime-log-chip` 同类处理），不放宽列宽——验收只要求不换行 + 超宽省略号。
4. **英文残留**：`formatTime` 与 `OverviewSheetView.relativeTime` 同口径（刚刚 / N 分钟前 / N 小时前 / N 天前）；Browser 的前端状态机枚举经 `BROWSER_PHASE_LABELS` 展示映射（`data-phase` 仍留原枚举）；插件启动状态同理；界面模式补中文 label；设置页 Owner 头的 owner id 换可读名（原 id 落 `data-owner`）；输入预测按用户口径改为「中文名（专名）」。
5. **渲染器字段行**：`.renderer-number-duo` 不再自带 `display`，改由组合选择器 `.renderer-setting-field.renderer-number-duo`（0,2,0）声明 `display:flex; flex-wrap:nowrap`——胜负不再取决于文件顺序。**nowrap 而非 wrap**：换行判据看的是假设主尺寸（滑块 220px）而非收缩后尺寸，实测 374px 容器下换行兜底会把 ↺ 推到第二行，与验收「四者同行」冲突；nowrap 下各子项按 `flex-shrink` 收缩，行最小宽度约 166px，窄容器也不溢出。
6. **模板库卡片**：删掉 `.template-preview` 自己的 `transform: scale(0.35)` + `width: 285%`——transform 不参与布局，布局盒仍是未缩放尺寸（实测 offsetHeight 378 / 视觉高 132）。内层 `SettingsPreview` 本来就按容器宽度 scale-to-fit，去掉外层缩放后**视觉效果不变**而布局盒等于视觉盒；卡片内隐藏预览自带的 caption（模板名与覆盖度已承担说明职责）。
7. **预设兜底 chip**：判据抽到 `presets.fallbackPresetChip` 并单测——内置预设 name 与自定义预设 id 都不出兜底 chip（后者交给具名列表），`'custom'` 哨兵显示「自定义」，未识别值显示「未知预设」且原值只进 `title`。
8. **预览栏**：新增折叠开关，状态与密度档同属 chrome 态（`localStorage`，key `pylon-settings-preview-collapsed`），折叠后为 44px 竖条；caption 明确标注「示意图（W×H 按 NN% 缩放，非真实尺寸）」。
9. **二次确认**：重置主题与删除自定义预设改为两段式（第一次点击进入待确认态，确认才执行），确认文案写明会丢什么（「恢复为本界面模式的默认值，且不可撤销」/「删除后不可恢复；引用它的区域会保留现值但失去预设基准」），取消零副作用。
10. **探测诊断**：新增 `presentDetectionDiagnostic` 纯函数——UI 只呈现「阶段 · 候选 · 本地化原因（可重试）」，内部码与系统级原文（`os error 193`、`%1 不是有效的 Win32 应用程序`）经 `raw` 报进运行日志 / Runtime sheet（`key: agent-detection:<code>:<detector>`，每轮先结清上一轮再覆盖式上报）。

## 验收标准与结果

实机核验环境：`F:\A-I\Platform\Pylon\pylon.exe`（本轮构建，md5 `c3f9855a…`），`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --remote-allow-origins=*"`；子项 1–4 视口 1920×1032（`.layout` 1920×988），子项 5–10 视口 1200×800。

| 验收项 | 结果 |
| --- | --- |
| 子项 1：`p-4` → 16px；`mt-4` → 16px；`mt-auto` / `ml-auto` 在真实 flex 流里贴底 / 右对齐 | ✔ 实测 `p-4` padding 16px、`mt-4` margin-top 16px、`px-3 py-2.5` → 10px/12px；功能探针 `mt-auto` offsetTop 190/200、`ml-auto` offsetLeft 190/200（探针须在 flex 流里测：绝对定位元素上 auto 外边距会被解析成 0，首版探针因此误报） |
| 子项 1：Gateway 分组标题不再被边框线穿过、History 页码对齐、Browser 注记贴底、Profiles 间距 | ✔ Gateway `.gateway-section.p-4` padding 16px（原 0px）；Browser 侧栏注记 `mt-auto` 恢复贴底；插件管理概览条 12px/10px、按钮行 `ml-auto` 生效、按钮 10px/3px（原全 0px） |
| 子项 2：Search / History / Prism 外壳 1920×988 | ✔ 三者实测 1920×988（原 528×988 / 394×988 / 688×410，Prism 内层 `.prism-sheet` 688×410 → 1920×988）；File / Overview / Runtime / Gateway 尺寸不变（1920×988） |
| 子项 2：内容区仍受 `max-w-[1120px]`；1000px 宽无横向滚动条 | ✔ Search 内容列 `max-width: 1120px`（实测列宽 960）；窗口 1000×800 时六张 sheet 全部 1000×756、`scrollWidth === clientWidth`，`documentElement` 无横向滚动条 |
| 子项 5：1000px 宽时字段行无溢出且无横向滚动条 | ✔ `.settings-body` 492/492；组合行 256/256 且五个子项同行 |
| 子项 3：`agent-stderr` 行与 `agent` 行等高、不换行、无横向滚动条 | ✔ 见下方实机对照 |
| 子项 4：侧栏时间为中文、无 `ago`；Overview 与侧栏同口径 | ✔ `formatTime` 与 `OverviewSheetView.relativeTime` 同文案；`grep -rn "d ago\|h ago\|m ago" src/` 无命中；设置页扫描 17 页 `ago` 命中数 0 |
| 子项 4：头像按钮 title 中文、Browser 状态中文、不再出现 `WebView session` | ✔ 扫描 17 页 `WebView session` / `ready` 命中均为 0；Browser 状态经展示映射 |
| 子项 4：输入预测字段标签、插件启动状态、界面模式三项、Owner 头口径 | ✔ 标签改「中文名（专名）」；启动状态「就绪。」（原 `ready`）；界面模式「经典终端」；Owner 头显示「消息流组件」等可读名，扫描 `app-shell` / `message-stream` / `control-center` 命中 0（原各 1） |
| 子项 5：渲染器页无横向滚动条、单位与 ↺ 与字段同行 | ✔ `.settings-body` 658/658（原 662/658）；组合行 374/374（原 374/414） |
| 子项 6：卡片高度贴合内容、无大面积空白、总高下降 | ✔ 预览布局盒 126px = 视觉高 126px（死空间 246px → 0）；卡片高 512 → 261；模板网格 1560 → 806；页面 scrollHeight 2368 → 1361 |
| 子项 7：生效预设只以用户命名出现一次、内部 ID 不入 UI | ✔ 预设行 chip 由 `★custom` → `★自定义`；无自定义预设 id 文案 |
| 子项 8：预览栏可折叠且状态被记忆、折叠后正文回升、无大面积空白、标注为示意 | ✔ 见下方实机对照 |
| 子项 9：重置主题与删除预设均有二次确认、文案说明丢失内容、取消零变化 | ✔ 见下方实机对照 |
| 子项 10：UI 无系统级原文与内部码、诊断可读、原文仍可取 | ✔ Agent 页扫描 `os error` / `%1 不是有效的 Win32` / `version_probe` 命中 0（原 4/4/12）；原文进运行日志（`agent-detection:*` key） |
| **统一回归项**：中控区 DOM 与样式与修复前一致 | ✔ 同视口（1920×1032）、同状态（中控区可见）同算法指纹：修复前 hash `-471839316` / 41 节点，修复后 **`-471839316` / 41 节点，逐条字符串相同**。注：首次基线是在中控区**隐藏**态取的（该态 `width` 报未解析的 `100%`、`margin` 报 `auto`，hash `-1937498202`），与布局态的 px 值不可直接比——这是测量口径问题，不是代码变化 |
| **统一回归项**：17 个设置页面无新增横向滚动、无新增裁切 | ✔ 见下方实机对照 |

### 实机对照（同一脚本、同一视口，修复前 / 修复后）

| 观察点 | 修复前 | 修复后 |
| --- | --- | --- |
| 子项 3 · Runtime 行高 | `agent-stderr` 行 37px / 单元格 37px，`agent` 行 30px / 单元格 19px | 全部行 30px、单元格 19px，来源列 `white-space: nowrap` |
| 子项 2 · 三 sheet 外壳 | Search 528×988、History 394×988、Prism 688×410 | 全部 1920×988 |
| 子项 6 · 模板库 | 每卡死空间 246px；卡片 512；页面 2368 | 死空间 0；卡片 261；页面 1361 |
| 子项 5 · 渲染器页溢出元素数 | 15（含 5 个容器沿链上溢） | 4，且 4 个与修复前**数值完全一致**（1 个 `pylon-select-value` + 3 个 provenance `code`，均带 `text-overflow:ellipsis`）——**无新增裁切** |
| 子项 7 · 预设 chip | `★custom`（内部哨兵上屏） | `★自定义` |
| 子项 10 · 诊断串 | 4× `os error 193`、12× `version_probe` | 0，改为「版本探测 · <候选> · 本地化原因」 |
| 子项 5 · 渲染器页 scrollHeight | 886 | 808（字段行不再换行成两行） |
| 17 页 `settings-body` 横向滚动 | 渲染器页 662/658（有） | 17 页 `scrollWidth === clientWidth`，横向滚动条 0 处 |
| 17 页超宽元素数（`scrollWidth > clientWidth`） | 模板库 22 / 全局 1 / 消息流 5 / 渲染器 4 / 输入预测 2 | **同上，一处未增**（逐个数一致；模板库那 22 个是卡片内 mock 的裁切框，设计如此） |

## 测试处置

**新增**

- `src/__tests__/utils.formatTime.test.ts`：四个分档中文口径 + 边界不跳档 + 不含英文缩写。
- `src/__tests__/cascadeLayerContract.test.ts`：层序声明存在、reset 在 `base` 层内且保留 `box-sizing`、reset 不以未分层形态再现（子项 1 的护栏，jsdom 不应用 CSS，只能查源码文本）。
- `src/components/settings/__tests__/agentDetectionDiagnostics.test.ts`：原文不进可见文本、`raw` 完整保留、可重试标注、未知阶段/未知码回退。
- `src/components/settings/__tests__/settingsChromeState.test.ts`：新增预览栏折叠态一节（缺省展开、往返读写、脏数据回退、不与密度档共用 key）。

**修改（逐个点名，均为既有断言锁定了旧文案/旧口径）**

- `src/components/settings/__tests__/SettingsSectionHeader.test.tsx`：断言由「徽标文本含 `message-stream`」改为「含可读名 + `data-owner` 为 `message-stream`」。
- `src/__tests__/settingsDomainNav.test.tsx`：同一处 owner 徽标断言同步（domain 跟随切换用例）。
- `src/components/settings/__tests__/AgentRuntimePanel.default.test.tsx`：诊断行断言由正则 `/version_probe_timeout.*version timeout/` 改为中文呈现串，并补一条「内部码不再出现在 UI」的反向断言。
- `src/__tests__/presets.test.ts`：追加 `fallbackPresetChip` 五例。

其余 576 个测试文件零修改。全量 `3909 passed`。

## 证据

- commit：见本记录所在提交（代码与测试一个提交、文档一个提交；L.md 单独一个提交）
- 测试：`vitest run` → `579 passed / 3909 passed`，退出码 0；`tsc -b` 通过；`eslint src/` 0 error（1 条既有 warning，位于 `src/components/right-panel/RightRailHost.tsx`，与本轮无关）
- 门禁：`check:first-party-styles`、`check:tailwind-tokens`、`check-css-var-consumption` 通过
- 手工验证：`tools/webview2-mcp` 对装机实例做修复前后同脚本对照（上表），中控区指纹前后一致
- 构建产物：`src-tauri/target/release/pylon.exe`（最终 md5 `6ce2e0f68965d7f77f9d45b8e79e9f65`；装机实例 `F:\A-I\Platform\Pylon\pylon.exe` 同步为该文件）。核验期间共重建 4 次：首版 + 组合行改 nowrap + 1000px 档补两处 + 撤回 provenance span 规则；每版都重装了实例复核
- 本地未跑 `check:rust`：本轮 `git diff --stat` 不含任何 `src-tauri/**` 改动，Rust 面零变更，该 job 由 CI 覆盖

## 核验期间的实例状态变更（如实记录）

核验用的便携版实例是仓库主的真实工作区，为取「修复前 / 修复后」对照，该实例被**反复重启并切换过 sheet**。副作用两条：

1. 桌面上的工作区标签页当前只剩 `Hermes\Riccati` 一个（原先并行开着 File / Browser / Search / Overview / History / Runtime / Gateway / Prism 等）。原因是强杀进程重启，未落盘的 sheet 列表丢失。这些是单例 sheet，可从标题栏「打开 Sheet」重新打开；本轮未代为改动。
2. 窗口尺寸被调试端口改过（1920×1032 / 1200×800 / 1000×800），最后一次停在 1920×1032。

除此之外未改动实例的任何配置：主题、预设、模型、会话内容都未被触碰（重置主题与删除预设只走到「待确认」就点了取消，见子项 9）。

## 与 spec 的偏差

1. **子项 5 的 `@media(max-width:1000px)` 未改为容器查询**。spec 方案 5 建议把响应式判据从视口改为容器宽度。实测该媒体查询不构成本次溢出的成因（成因是 display 冲突），且改为 `@container` 需要给祖先加 `container-type: inline-size`，会带来容器包含的新副作用；同时该媒体查询当前在 586px 宽的容器上本就不会触发，改成容器查询反而会让它在宽视口下也触发、改变既有网格行外观。改为 nowrap 契约后字段行在任意容器宽度下都不溢出，响应式需求已由收缩满足。**结论：不改，理由如上**。
2. **子项 4a 未全量中文化**。按仓库主中途给出的口径（「不一定要全盘去掉任何英文，关键是去掉突兀的」）改为「中文名（专名）」，保留 `Base URL` / `API Key` / `Temperature` / `Top P` / `Seed` 的英文原名作括注。
3. **子项 8 的「预览栏不再出现大面积空白」按「可折叠 + 标注示意」处置**，未改预览内容本身的呈现方式（spec 未决问题 6 的两个选项里取了成本更低、不动视觉真值的那条）。
4. **文档同步项 2 无对象**：spec 要求同步修订 `docs/说明书/Pylon-开发与协作规范.md` 样式节，该文件已不存在（协作规范落在 `AGENTS.md`，样式约定在 `.agents/dev-standards.md`，后者已改）。
5. **施工书 / 台账修订未做**（spec 文档同步项 3、6、7）：`Docs/施工书/**`、`Docs/Pylon-问题台账.md` 在仓库外，本轮不越界改动；`Pylon-Tailwindv4引入施工书` §8 与台账 P90 / P93 的表述修订请仓库主在文档库侧处置。
6. **门禁补强未做**（spec 文档同步项 8）：为 P93 验收补「计算样式断言」超出本 issue 范围，本轮只补了源码文本级的层叠契约测试。

## 未解问题

1. `formatTime`（`src/utils.ts`）与 `OverviewSheetView.relativeTime`（`src/sheets/OverviewSheetView.tsx`）仍是两份实现，只是口径已对齐。合并属重构，未做。
2. 子项 1 的回归面只能靠实机比对（本轮已做），无自动化手段覆盖「既有声明浮起」这类层叠变化——`cascadeLayerContract.test.ts` 只锁住了 reset 的位置，锁不住「其他未分层规则」。
3. 渲染器页仍有 3 个 provenance `code` 元素与 1 个下拉值时值超宽而省略——与修复前数值一致（非本轮引入），但若要求这行元数据完整可读，需要另开 issue 调整 provenance 行的宽度预算。
4. 子项 9 只覆盖 spec 点名的两处；「重置本区」（`resetZone`）同样是破坏性操作但未加确认。

## 并行交集

本轮碰过的共享文件，供其他贡献者避让：`src/index.css`（**层序声明，最需注意**）、`src/styles/tailwind.css`（仅注释）、`src/settingsDomains.ts`、`src/presets.ts`、`src/utils.ts`、`builtin.pylon-shell/styles/components/Settings.css`、`builtin.pylon-workspace/styles/components/PrismSheet.css`、`src/components/Settings.tsx`。已在 `.agents/L.md` 留下 #116 条目。
