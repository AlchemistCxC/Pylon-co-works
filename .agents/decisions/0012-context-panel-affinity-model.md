# ADR-0012 右栏面板模型：Sheet 种类从「可用性闸门」改为「亲和默认」

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0012-context-panel-affinity-model.md`

- **日期**：2026-09-18
- **状态**：已采用
- **关系**：与 ADR-0009（左列几何）、ADR-0011（左栏内容模型）正交——本 ADR 只改**右栏**（上下文面板）的**选择模型**。放宽 ADR 未记载的旧约定「上下文面板按 `scope`/`workspaceKind` 过滤出可用集」。

## 背景与约束

用户诉求（原话）：「切换右侧栏类型的按钮放在右侧栏内部」「侧栏内部没有切换侧栏种类的按钮」；在我说明这属于契约层改动、问他是否要开这个口子之后：「当然，我支持你重新设计侧栏模型」。

只读核查（浏览器实测 + file:line）确认旧模型的结构性病灶：

| 现象 | 事实 |
| --- | --- |
| 种类即闸门 | `selectAvailableContextPanels` 按 `scope`/`workspaceKind` 过滤（旧 `contextPanelSelection.ts:15-17`）：agent Sheet 只剩「上下文」，file Sheet 只剩「关联」。 |
| 于是没有切换器 | 右栏头部 `.context-panel-tabs` 只列可用面板 → 单面板 Sheet 只画一个标签，且 `.context-panel-mode { flex:1 }` 把它撑满 271px，看上去是标题。用户「找不到切换种类的按钮」的根因在此，不在样式。 |
| 两处切换入口 | 标题栏也有一个「右侧栏」菜单在切面板（与右栏内部重复）。该重复已在同批改动中删除（标题栏只负责折叠）。 |
| 闸门与语义混轴 | `when`（此刻该不该显示）与 `workspaceKind`（适不适合这个 Sheet）本是两回事，却被压成同一条「可用性」轴，插件的表达力因此被吃掉一半。 |

约束：本项目无用户、无插件市场、无现成插件（用户早前已授权破坏性更新）；但本次**不需要破坏**——字段形状不变即可达成目标。

## 决定

1. **`workspaceKind` 的语义改为「亲和」（affinity），不再是闸门**：面板不会因为 Sheet 种类不匹配而从右栏消失；用户可以在切换器里选任意面板。`scope: 'contextual' | 'global'` 随之只影响**默认选中**（`global` 是「任何 Sheet 都能当默认」的兜底），不再影响可显示性。
2. **`when` 仍是硬闸门**：它表达的是「此刻这个面板根本没有意义」（例如无会话时不显示）。两条轴分开后，插件既能「此刻隐藏」，也能「声明亲和的 Sheet 种类」。
3. **没显式选过时的默认选中顺序**：声明了当前 Sheet 种类的面板 → 第一个 `global` 面板 → 列表第一个（`resolveContextPanelDefault`）。用户显式选过的面板记在 `rightRailStore.activePanelId`，**跨 Sheet 保持**——切 Sheet 不该把用户刚选的栏抢回默认值。
4. **选择器改名 `selectAvailableContextPanels` → `selectContextPanels`**：旧名字里的 "Available" 正是被否掉的语义，留着会继续误导（调用方 4 处：`App.tsx` 的右栏可用性、`WorkspaceTitlebar` 的按钮禁用、`RightRailHost` 的面板清单、`ContextPanelHost` 的切换器）。
5. **切换器列出全部可显示面板**（`when` 之上的全部），标签不再 `flex:1` 撑满：一排标签在任何面板数量下都读得出「这是切换器」。
6. **右栏内部不再有第二个折叠钮**（同批改动）：折叠只有标题栏一处所有权；插件经 `host:collapse` 请求收起的通路保留。
7. **插件 API 升 minor 至 2.2**：按 §6.11.3 的「minor 只做加法」纪律，本次是纯放宽——字段形状不变、既有清单无需改动，只是面板变得可选中，因此不升 major。

## 后果

- 正面：右栏从「跟着 Sheet 种类走的单面板」变成「用户可选的面板栈」，切换器在任何 Sheet 上都成立；`when` 与 `workspaceKind` 各归其位，插件表达力恢复。
- 正面：删掉了标题栏那处重复的面板切换入口（真正的「单一主人」），标题栏右簇只剩齿轮菜单 + 折叠钮。
- 负面：把 agent Sheet 的右栏切到「关联」这类面板时，面板拿到的是该 Sheet 的上下文，可能显示空态（`FileContextPanel` 读的是应用级 activeFile，实测显示「关联会话（无文件）」提示，不崩）。这是「用户显式选择」的必然代价，不做二次拦截——拦回去等于把闸门又装回来。
- 风险：面板清单现在与 Sheet 种类无关，`when` 写得宽松的插件面板会出现在所有 Sheet 上。这是插件的责任，宿主不再代为裁剪。
- 风险：`activePanelId` 是全局偏好（持久化在 `pylon-workspace-layout-v3`）。若将来要「每种 Sheet 种类各记一个选择」，需要把它改成映射——本次不做，等有实际诉求再说。

## 证据

- 选择器：`src/plugin-runtime/context-panel/contextPanelSelection.ts`（`selectContextPanels` / `resolveContextPanelDefault`）
- 消费方：`src/App.tsx`（右栏可用性）、`src/workspace-sheets/WorkspaceTitlebar.tsx`（按钮禁用）、`src/components/right-panel/RightRailHost.tsx`（清单 + 默认选中）、`src/components/right-panel/ContextPanelHost.tsx`（切换器）
- 契约测试：`src/plugin-runtime/context-panel/__tests__/contextPanelRegistry.test.ts`（只按 `when` 裁剪 / 亲和默认三档回退）、`src/components/right-panel/__tests__/ContextPanelHost.test.tsx`（跨种类可切 / 亲和默认优先于 order / 头部只剩切换器）
- 版本：`src/plugin-runtime/packageManifest.ts`、两份 `pylon-plugin-manifest.schema.json`
- 实机：见 `.agents/records/` 对应开发记录的实测数值
