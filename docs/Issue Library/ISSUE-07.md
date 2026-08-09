# ISSUE-07：FileSheet source 清空与异步代际

> 正式编号按 Release 实施依赖关系编排。原问题编号保留在正文中，便于追溯历史记录。

## 当前状态

- 正式编号：`ISSUE-07`
- 原问题编号：`#5`
- 状态：已交付（方案已写入）
- 依赖：ISSUE-01
- 简介：无 source 时清空 Git/Views/File 数据，并阻止旧请求回写。
- 来源：`docs/release-issues.md`

## 并行执行元数据

```yaml
formal_id: ISSUE-07
status: 已交付（方案已写入）
lane: frontend-file
priority: P1
stage: consumer
size: M
dependencies: ["01-A"]
blocks: ["08-A"]
likely_modify: ["src/sheets/file/", "src/workspaceStore.ts"]
do_not_modify: ["不实现完整 Git 工作台"]
execution_rule: "先完成任务卡依赖，再领取本 Issue 的 ready slice；跨 Lane 变更必须经 contract/checkpoint。"
```

> 此处是 Harness 的机器可读入口。Issue 级状态不等于所有 slice 完成；以 `harness/queue.json`、任务卡和 checkpoint 为准。

## 原始问题记录

原问题编号：#5
严重度：P1
状态：已交付（方案已写入）

问题现象：
宫木云汇报：
“FileSheet 未选中任何会话时，SCM 和视图分区依然有 Git 状态和文件变更速览。”

触发条件：
1. 打开或复用一个曾经指向某会话的 FileSheet。
2. 当前应用会话选择变为 null，或用户认为 FileSheet 当前没有选中会话。
3. 切换到 SCM / 视图分区。
4. 仍能看到之前工作区的 Git 状态、提交记录或文件变更速览。

问题根因：
FileSheet 的工作区目标不是从当前 activeSession 响应式派生，而是在组件首次挂载时从 `sheet.singletonKey` 或当时的 activeSession 初始化为本地 `targetSource`，之后 activeSession 变为 null 不会清空该目标；同时 GitPanel / ViewsPanel 在 `source` 为空时只提前 return，不主动清空已加载的 Git state。由此，页面视觉上的“未选中会话”与内部仍保留的旧 `targetSource`/旧 entries 发生分离，SCM 和视图继续展示旧工作区数据。

证据等级：L2 源码证据。

相关源代码：
- `G:/Project/prism-desktop/src/sheets/file/FileSheetView.tsx:26-38`
  - `initialSource` 由 `sheet.singletonKey` 优先决定；`useReducer(..., initialSource, createFileSheetState)` 只在首次挂载初始化。
- `G:/Project/prism-desktop/src/sheets/file/fileSheetState.ts:21-30`
  - `targetSource` 只会在显式 `set-source` action 时改变，不跟随 activeSession 变更，也没有 clear action 的专用接线。
- `G:/Project/prism-desktop/src/sheets/file/FileSheetSidebar.tsx:75-103`
  - 会话列表只能选择某个 source，没有“取消选择/清空工作区”入口。
- `G:/Project/prism-desktop/src/sheets/file/GitPanel.tsx:76-95`
  - `if (!source) return` 不会清空 `staged`、`unstaged`、`history`；旧异步结果和旧 state 可保留。
- `G:/Project/prism-desktop/src/sheets/file/ViewsPanel.tsx:22-41`
  - `if (!source) return` 同样不清空 `entries` 和 `error`。

解决方案：

方案 A（推荐，显式工作区选择模型）：
- 改动位置：`FileSheetView.tsx`、`fileSheetState.ts`、`FileSheetSidebar.tsx`、`GitPanel.tsx`、`ViewsPanel.tsx`。
- 具体改法：
  1. 将 FileSheet 的 `targetSource` 定义为显式工作区选择，不再让“当前 activeSession 是否为空”与“FileSheet 当前 targetSource”形成隐式关系。
  2. 会话分区增加“未选择工作区/清除选择”入口，dispatch `{ type: 'set-source', source: null }`。
  3. source 变为 null 时同步清除 `activeDiff`、当前文件 tab/selection 是否清除需按 FileSheet 持久化策略决定；至少 SCM、Views、FileTree、Search 不得继续请求或显示旧 source 数据。
  4. `GitPanel` effect 在 `!source` 分支执行 `setStaged([])`、`setUnstaged([])`、`setHistory([])`、`setError(null)`。
  5. `ViewsPanel` effect 在 `!source` 分支执行 `setEntries([])`、`setError('')`；touchedFiles 已按空 source 派生为空。
  6. 所有异步回调继续使用 disposed/generation 防止旧 source 的响应在清空后回写。
- 影响面：明确区分“FileSheet 固定指向某工作区”和“没有工作区”；不改变已选择会话时的 Git/文件业务。清空 source 后主区已打开文件是否保留需要与问题 #6 的文件视图统一策略一起拍板。【需拍板】
- 验证方式：
  1. 选择会话 A，SCM 显示 A；清除选择后 staged/unstaged/history 全空并显示引导。
  2. 清除时存在在途 git_status/git_history，迟到响应不得重新显示 A。
  3. A→B 快速切换，最终只显示 B。
  4. Views 的 Git entries 与 Agent touchedFiles 同时归零。
  5. 重开 FileSheet 后 singletonKey 指向语义与 UI 选中态一致。
- 风险与取舍：需要把 FileSheet 当前工作区选择做成用户可见状态；这是消除“看起来未选中但内部仍指向旧 source”的必要改动。

方案 B（最小防御）：
- 改动位置：仅 `GitPanel.tsx`、`ViewsPanel.tsx`。
- 具体改法：source 为空时清空组件 state。
- 影响面：防止真正 source=null 时显示旧数据，但不能解决 FileSheet 本地 `targetSource` 仍保留旧会话的问题。
- 风险与取舍：只能修复陈旧 state，无法修复工作区选择模型，不推荐单独交付。

---

### 源码复核后的实施细化

1. `FileSheetView` 当前 `useReducer` 初始 source 只执行一次；先新增显式 `clear-source`/`set-source(null)` 的 UI 入口，再决定 activeSession 变化是否自动清空，避免把两个选择模型混在一起。
2. source 变更时清理 `activeDiff`、GitPanel/ViewsPanel 本地 entries/error、文件树请求上下文；每个 effect 用 `disposed + requestGeneration/source` 防旧响应回写。
3. `GitPanel` 与 `ViewsPanel` 的 `!source` 分支必须先 reset state，再 render empty hint；仅 `return` 不足以清除已加载数据。
4. 先补 reducer、组件 effect、source A→null→B 测试，再实施 #6 的视图域拆分。

可行性：高。reducer 已接受 null，缺口主要是 UI 清空入口、effect reset 和异步代际。

---


## 逐项验收清单

### 6.8 问题 #5：FileSheet 无 source 时清除旧数据

#### 等级 1：测试通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| source reducer | `set-source(null)` 得到明确空工作区状态 | `src/sheets/file/fileSheetState.ts` tests | [ ] |
| Git/Views reset | source 为空时 staged/unstaged/history/entries/error 清空 | `GitPanel.tsx`、`ViewsPanel.tsx` component tests | [ ] |
| 异步代际 | A→null→B 或 A→B 快切时，A 的迟到响应不能回写 | FileSheet component/integration tests | [ ] |

#### 等级 2：前端网页验收通过（仅限前端）

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 清除工作区入口 | 在 File Sheet 会话分区点击“清除选择”后，SCM/Views/FileTree/Search 显示空态 | `http://localhost:5173/` → 打开 File Sheet → 左侧会话分区 | [ ] |
| 旧数据不残留 | 先加载 mock A 的 Git 数据，再清空/切 B，页面不再出现 A 的文件和提交 | `http://localhost:5173/` → File Sheet → SCM/视图 | [ ] |
| 主区策略 | open tabs/active diff 按产品拍板执行保留或清空，UI 与说明一致 | `http://localhost:5173/` → File Sheet 主区 | [ ] |

#### 等级 3：真实应用验收通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 真实 Git 工作区清空 | 选择真实会话 A 后可见 Git；清空 source 后所有 Git/Views 数据消失 | 真实应用 → File Sheet → SCM/视图 | [ ] |
| 在途请求 | 大仓库读取中清空或切换 source，迟到结果不得重新出现 | 真实应用 → File Sheet；Runtime Sheet 查看 command 时间线 | [ ] |
| 重开一致性 | 关闭并重开 File Sheet 后，singletonKey、选中态和实际工作区一致 | 真实应用 → File Sheet | [ ] |

## 施工日志

| 2026-08-09 | 拍板决策同步 | 已将本轮已确认的产品决策与当前实施成熟度写入“已拍板决策”。未形成措施的内容明确标注为仅有决策。 | 关联未决策项见 `未决策项.md` |
| 日期 | 类型 | 记录 | 证据/备注 |
|---|---|---|---|
| 2026-08-09 | 文档拆分 | 从 `docs/release-issues.md` 拆分为 `ISSUE-07`；保留原问题记录、追加调查、修复记录与三级验收内容。 | 本文件生成于 Issue Library 初始化 |
|  |  |  |  |


## 本轮源码核验与可验收子任务（2026-08-09）

### 逐条源码核验矩阵

| 原主张 | 判定 | 当前源码证据 | 方案修正 |
|---|---|---|---|
| FileSheet 顶层仍持有 source 相关临时状态 | 属实 | `src/sheets/file/FileSheetView.tsx:26-101` 的 reducer、`activeDiff`、局部 sidebar state | source null 时集中 reset；A→null→B 必须测试。 |
| 仅 render empty hint 即完成清理 | 不属实 | `ViewsPanel.tsx:11-67` 仍消费 state/activeDiff；异步 effect 可迟到 | 每个请求绑定 source/generation/disposed，旧响应不得回写。 |


> 本节是本轮对当前源码的增量审计与执行切分。原编号只用于追溯；以下 task id 才是 Harness v2 的执行单位。

### 核验结论
- 🟡 reducer 接受 `null`，但 FileSheet 顶层仍维护 `activeDiff`，Views/Git 子域仍有各自 state；“无 source 已完整清空”不能由现有结构推出。证据：`src/sheets/file/FileSheetView.tsx:26-101`、`src/sheets/file/ViewsPanel.tsx:11-67`。

### 子任务清单

| Task ID | 类型 | 归属 | 依赖 | 验收标准 | 最低证据 |
|---|---|---|---|---|---|
| `I07-A-FE-01` | FE | A | I01-A-BE-01 | FileSheet source null 清理状态；source A→null 清除 Git/Views/diff/file state；空态无旧数据。 | L1 |
| `I07-A-FE-02` | FE | A | I07-A-FE-01 | 异步请求 generation/source guard；旧 source 响应不能回写新 source；disposed 后不更新 state。 | L1 |
| `I07-B-UX-01` | UX | B | I07-A-FE-01 | FileSheet 空态与切换过渡视觉；仅改局部视觉层，保留现有布局契约，过渡可关闭且不遮挡操作。 | L2 |
| `I07-A-TEST-01` | TEST | S | I07-A-FE-02 | source 清空与异步代际回归；覆盖 A→null→B、迟到 Git/Views 响应和切换期间关闭组件。 | L2 |

### 本轮施工日志

| 2026-08-09 | 源码核验 + 任务切分 | 已对照当前源码建立证据结论；按一张卡一个独立可验收结果切分，B 视觉任务仅在基座/契约明确后进入。 | `docs/Issue Library/harness-v2/` |
