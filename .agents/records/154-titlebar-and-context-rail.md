# Dev Record — #154 阶段 2 续 标题栏菜单合并与右栏面板模型

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/154-titlebar-and-context-rail.md`

## 元信息

- issue：#154（阶段 2「标题栏排布」的续做 + 右栏内容模型）
- 分支：`Ru5t/Reflector`（PR #169）
- 提交范围：`e4fbbf84..<本批>`
- 日期：2026-09-18
- 规格：`.agents/spec/154-titlebar-menu-consolidation.md`（不入库）
- 决策：`.agents/decisions/0012-context-panel-affinity-model.md`（右栏面板模型）；左栏模型见 ADR-0011

## 目标与范围

用户四轮实机反馈驱动，逐条对齐后施工：

1. 「把界面和设置放在一个菜单里，图标就是设置，点击后展开二级菜单可以看」+「这里也可以插件化处理提供注册这个选单的能力（注意同步说明书）」
2. 「右侧栏按钮也图标化，切换右侧栏类型的按钮放在右侧栏内部，右侧栏按钮只负责折叠」
3. 「新建 sheet 像浏览器一样往右边放」「那个重置还是切换上一个关掉的 sheet 的按键不要了」
4. 修正轮：「侧栏内部也出现了折叠按钮（titlebar 也有）」「侧栏内部没有切换侧栏种类的按钮」「…和侧栏折叠按钮和窗口控制三按钮高度不一致，可以重新绘制下侧栏折叠按钮，用个别的图标」「还是出现了有 sheet 被截断没有被完整放进容器」
5. 授权轮：「当然，我支持你重新设计侧栏模型」→ 右栏面板选择模型重设。

**不做**：左栏（ADR-0011 已定稿）、窗口三键行为、`app-actions` 槽既有渲染方式、Sheet 页签的右键菜单与 `workspace.sheet.reopen` 命令（只删标题栏那个按钮）、插件 API 的字段形状（两次都只做加法/放宽）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/workspace-sheets/WorkspaceTitlebar.tsx` | 齿轮菜单（三段：界面模式 / 设置域 / 插件项）、右栏按钮改为只折叠 + 画出的面板图标、删重开按钮与分隔线 | 修改 |
| `src/workspace-sheets/SheetTabStrip.tsx` | 溢出机制由「横向滚动 + 边缘渐隐」改为「算装得下几个，其余不渲染、进「···」选单」；活动页签在窗口外时窗口平移 | 修改 |
| `src/components/right-panel/ContextPanelHost.tsx` | 删右栏内部折叠钮；切换器列全部可显示面板并按内容宽；选择写入 store | 修改 |
| `src/components/right-panel/RightRailHost.tsx` | 面板清单改用新选择器；没选过时用亲和默认 | 修改 |
| `src/plugin-runtime/titlebar/{titlebarTypes,titlebarRegistry}.ts` | 新增 `slot:'app-menu'` + `renderKind:'command'` 数据化菜单项与 fail-closed 注册期校验 | 修改 |
| `src/plugin-runtime/context-panel/contextPanelSelection.ts` | 选择器改名 `selectAvailableContextPanels` → `selectContextPanels`（只按 `when` 裁剪）+ 新增 `resolveContextPanelDefault`（亲和默认） | 修改 |
| `src/plugin-runtime/packageManifest.ts` + 两份 `pylon-plugin-manifest.schema.json` | 插件 API 2.1（app-menu 槽）与 2.2（右栏面板亲和） | 修改 |
| `src/App.tsx` | 标题栏 props 收敛（删 `canReopenSheet` / `onReopenSheet`）；右栏可用性改用新选择器 | 修改 |
| `builtin.pylon-shell/styles/App.css` | 页签区收缩到内容宽、页签之间小竖线、标题栏可点盒子高度统一、右栏面板图标（CSS 画出）、删滚动时代死规则 | 修改 |
| `builtin.pylon-workspace/styles/components/right-panel/ContextPanel.css` | 切换器标签按内容宽 + 省略号；删已无消费方的折叠钮规则 | 修改 |
| `.agents/decisions/0012-context-panel-affinity-model.md` | 右栏面板模型决策 | 新增 |
| `docs/说明书/Pylon-插件系统说明书-开发者版.md` | §6.8 面板选择模型表、§6.8.1 标题栏贡献与设置齿轮菜单（新章）、§3.1/§6.11.3 版本策略、§1 api 取值 | 修改 |
| 测试：`workspaceTitlebarLaunchers` / `workspaceTitlebarSidebarToggle` / `workspaceTitlebar.css` / `sheetTabOverflow` / `agentStatusConsumerMatrix` / `ContextPanelHost` / `contextPanelRegistry` / `titlebarRegistry` / `packageManifest` | 见「测试处置」 | 修改 |
| `package.json` / `src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}` / 三份说明书头 | 版本 0.2.1 → 0.2.2 | 修改 |

## 方案要点

1. **标题栏右簇两个控件**：齿轮菜单（界面模式 radio + 设置域跳转 + 插件项）+ 右栏折叠钮。原「界面」「设置」两个文字触发与「右侧栏」菜单（第三处面板切换入口）全部删除。菜单外壳（分段标题、图标、键盘导航、错误边界）归宿主，插件只声明 `label` / `icon` / `commandId`。
2. **`slot:'app-menu'` 是唯一数据槽**：`app-menu` ⇔ `renderKind:'command'` 互相绑定，`commandId` 必填（点了没处去是死路），注册期 fail-closed 拒绝错配。菜单项点击经命令注册表执行，失败记账不炸标题栏。
3. **页签不滚动**：`SheetTabStrip` 用 CSS 变量（`--sheet-tab-min-width` / `--sheet-tab-agent-min-width` / `--sheet-tab-overflow-trigger-width`）当尺子，按**标题栏中格**宽度算「装得下几个」，装不下的不渲染、进「···」选单（选单列全部页签）。可用宽度取中格而非页签区自己——页签区按内容撑开，拿它当尺子会自指；中格宽度与渲染数量无关，无反馈环。量不到宽度（首帧 / jsdom）一律按「全放得下」处理，不做假定。
4. **标题栏高度统一**：所有可点盒子 = `--ui-control-standard`（36px）+ 垂直居中。此前窗口控制是 `margin:4px 0` + 计算高度（比图标钮低 0.5px），「···」通高 43px，同一行三种几何。
5. **右栏面板模型**：`workspaceKind` 由「可用性闸门」改为「默认选中的亲和」；`when` 仍是硬闸门；用户显式选择写入 `rightRailStore.activePanelId`（持久化、跨 Sheet 保持），只有没选过才吃亲和默认。详见 ADR-0012。
6. **删按钮不删能力**：重开最近关闭 Sheet 的命令与页签右键菜单保留；右栏折叠的插件通路 `host:collapse` 保留。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `[data-menu-trigger]` 恰好 1 个（值为 `app-menu`），右栏钮 1 个 | ✅ 实测 |
| 齿轮菜单含界面模式 radio / 设置四域 / 插件段（无注册方时不渲染） | ✅ 实测（`界面模式`+`设置` 两段标题；插件段用例覆盖） |
| 点击 `app-menu` 贡献 → 执行 `commandId` | ✅ 用例（`command` 间谍被调用一次，菜单关闭、焦点回齿轮） |
| 右栏钮只折叠：`collapsed` 与 `aria-expanded` 反相、标签翻转 | ✅ 实测 `data-collapsed` false→true、宽度归零、标签「收起右侧栏」→「展开右侧栏」 |
| 页签「+」紧贴最后一个页签、且与页签之间无竖线 | ✅ 实测 2400px 下页签区 = 内容宽 1596、末页签右 1846 / 「+」左 1854（8px = 启动器内边距）；「···」`border-left: 0px` |
| 页签不被截断 | ✅ 实测 1280px 下渲染 7/12，末页签右边 = 页签区右边（溢出 0.00px），「···」选单列 12 项 |
| 页签随数量压缩 | ✅ 2400: 5×136+7×111（不折叠）；1920: 5×136+7×97；1280: 触底 96 后折叠 |
| 选中被折叠页签后窗口平移、活动页签可见 | ✅ 实测：选 Browser → 窗口变为 `File…Browser`，Browser 在末尾可见，仍 0 溢出 |
| 标题栏「···」/ 右栏钮 / 齿轮 / 「+」/ 窗口三钮同高同基准 | ✅ 终端风格全部 36 高、top 3.5；现代 GUI 全部 34 高、top 12 |
| 右栏内部无折叠钮、头部只剩切换器 | ✅ 实测 + 用例（`.context-panel-collapse` 不存在） |
| 右栏切换器在 agent Sheet 上可切到 file 面板 | ✅ 实测：切到「关联」→ 面板切换、落盘 `activePanelId=builtin.context-panel.file`；**整页重载后仍保持**；切回「上下文」落盘 `builtin.context-panel.agent` |
| 没选过时默认亲和的同种类面板 | ✅ 用例（亲和面板优先于 order 更靠前的 global 面板） |

## 测试处置

| 测试 | 处置 |
| --- | --- |
| `workspaceTitlebarLaunchers.test.tsx` | 改写：重开按钮「已删除」而能力保留；右簇单菜单触发；三段菜单内容；插件项命令执行 + `when` 门控；焦点回位回归到齿轮 |
| `workspaceTitlebarSidebarToggle.test.tsx` | 改写：`[data-menu-trigger]` 由 `['right-panel','interface','settings']` 收敛为 `['app-menu']`；右栏按钮断言改为 `[data-right-rail-toggle]` 与标签文本 |
| `workspaceTitlebar.css.test.ts` | 扩到 9 条：右栏钮与齿轮同规格、溢出触发器无左边线、页签可压缩（flex + token）、页签区不滚动且无滚动时代死规则、页签小竖线、高度统一、面板图标为画出而非箭头 |
| `sheetTabOverflow.test.tsx` | 重写（5 例）：量不到宽度不做假定全渲染 / 折叠多余页签且选单列全部并能切换 / 活动页签在窗口外时窗口平移 / 变宽恢复全部 / Esc 关闭。**不降级**：旧用例断言的滚动标志（`can-scroll-*`）随机制删除而删除，不是放宽断言 |
| `agentStatusConsumerMatrix.test.tsx` / `workspaceTitlebarSidebarToggle.test.tsx` | 删除已不存在的 `canReopenSheet` / `onReopenSheet` 传参 |
| `titlebarRegistry.test.ts` | 新增：`slot`/`renderKind`/`commandId` 配对错配与空值、`id` 首尾空格、`label` 空、合法项冻结 |
| `ContextPanelHost.test.tsx` | 改写 + 新增：切换器列全部面板且跨种类可切、选择落 store、亲和默认优先于 order、头部只剩切换器 |
| `contextPanelRegistry.test.ts` | 改写：只按 `when` 裁剪（种类不再是闸门）+ 新增亲和默认三档回退（亲和 → global → 首个；空列表 undefined） |
| `packageManifest.test.ts` | 新增 api=2.1 / 2.2 接受；未知更高版本（2.2→改 2.3 断言、2.3→2.3 断言）仍拒绝 |

## 证据

- commit：（本记录提交时补于 commit message）
- 测试：`bunx vitest run` → **601 文件 / 4380 用例通过 + 2 todo**；`bunx tsc -b` 无输出；`bun run lint` 0 error（仅既有 `RightRailHost` warning）；`check:docs` / `check:first-party-styles` / `check-plugin-manifests` / `bun run test:pack` 均通过
- 手工验证（浏览器 dev server `http://localhost:5173/`，mock Tauri 后端；几何数值见上表）：
  - 菜单三段与插件项：`data-menu-kind="app-menu"`，`界面模式` / `设置` 段标题，四域 `appearance/workspace/agents-connections/plugins`
  - 右栏切换与持久化：`localStorage['pylon-workspace-layout-v3'].state.activePanelId` 由 `builtin.context-panel.file` ↔ `builtin.context-panel.agent`
  - 页签不截断：末页签右边 983 = 页签区右边 983（`clippedBy: 0`）
- 一次全量运行出现 1 条失败，随后两次全量均绿、涉及文件单独跑也绿，未复现（本仓此前记录过全量并行下进程类用例被饥饿击穿的先例）。

## 与 spec 的偏差

- spec（`.agents/spec/154-titlebar-menu-consolidation.md`）写的是「切换器只列可用面板、不适用的照列但禁用」；用户在下一轮授权「重新设计侧栏模型」，最终实现改为**只按 `when` 裁剪 + 种类只做亲和**，比 spec 更彻底（见 ADR-0012），spec 的按钮/高度/页签部分全部落地。
- spec 未覆盖右栏面板模型（当时判定为「要不要开这个口子由用户定」），授权后另行登记 ADR-0012。

## 未解问题

- 右栏有两排形态相近的标签：头部是宿主的面板切换器（上下文 / 关联），下面是 `AgentContextPanel` 自己的子导航（搜索 / 关联）。已向用户提出，等他定是否给子导航换视觉语法（如下划线式）。
- `rightRailStore.activePanelId` 是**全局**偏好，不区分 Sheet 种类。若将来要「每种 Sheet 种类各记一个选择」，需改成映射。
- 长按拖拽手感（左栏）与 `--motion-*` 时长仍只有用户能判。
