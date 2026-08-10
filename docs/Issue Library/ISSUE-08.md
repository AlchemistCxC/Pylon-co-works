# ISSUE-08：SCM、Views 与 FileViewHost 拆域

> 正式编号按 Release 实施依赖关系编排。原问题编号保留在正文中，便于追溯历史记录。

## 当前状态

- 正式编号：`ISSUE-08`
- 原问题编号：`#6`
- 状态：已交付（方案已写入）
- 依赖：ISSUE-07
- 简介：SCM 独占 Git 工作台，Views 展示 Agent touched files，统一文件/diff tab host。
- 来源：`docs/release-issues.md`

## 已拍板决策（2026-08-09）

### D-01：FileSheet 工作区按 Agent/Session 独立记忆

- FileSheet 的 tabs、active tab、选区和视图状态按 `agentId + sessionId/source` 隔离。
- 切换会话时隐藏原会话工作区并恢复目标会话上次状态；切回时恢复原状态。
- 会话删除只销毁该会话的 FileSheet 状态。
- 文件、搜索、Git 请求不得依赖全局 active Agent，必须使用文件工作区所属 context。

实施方案成熟度：**仅有产品决策与状态边界，持久化 schema 尚未设计。**

### D-02：文件 tab identity 与视图状态分离

- 同一路径默认只有一个文件 tab；Git diff 不是独立 tab。
- tab 的核心 identity 是 Agent/Session context + path。
- 视图状态至少包括：普通文件、编辑态 diff、Git diff、净增、净减。
- Files/Search/Views 打开文件时进入普通视图；SCM 打开或聚焦同一文件后切换到 Git diff。
- 所有视图共用 tab strip、路径、状态栏、加载态、错误态、快捷键和导航。

实施方案成熟度：**已有领域方案，当前源码 `openTabs:string[]` 的 versioned migration 尚未设计。**

#### decision_log

- **I08-A-FE-01（2026-08-10）——「同路径 file/diff 共存两 tab」与「Git diff 不是独立 tab」的解释关系**：本卡落地 tab 单例 key = `${mode}:${path}`（同路径 file/diff 并存为两个 tab、不互相覆盖，满足卡 AC-1"同路径 file/diff tab 不互相覆盖"）。这与 D-02"Git diff 不是独立 tab"不冲突：D-02 的根因语义是 Git diff 不得脱离 FileSheet 的 tab strip 与主区宿主成为顶层独立面板（旧实现 `activeDiff` 顶层替换主区、无 tab 归属）；实现中 diff-mode 是统一 `FileViewHost` 内的一种视图模式，与 file 共用 tab strip、路径、状态栏、加载/错误态与快捷键，SCM 打开或聚焦同一文件即切换到该文件的 Git diff 视图（复用已存在的 diff-mode tab 则只更新 staged 范围）。供 L2/L3 验收与后续卡（I08-A-FE-02）参照。
- **I08-A-FE-02（2026-08-10）——真实编辑/save/working-diff 语义落地（D-03/D-05）**：本卡在 `FileTabView`/`FileViewHost` 内启用真实文本编辑（受控 textarea，与只读视图共用同一文件 tab identity 与状态栏，不另建平行编辑页）。`working-diff` 基线 = 最近一次成功保存（或加载）的磁盘文本，目标 = 当前未保存编辑；`workspaceWrite.ts` 保存时把基线作为 `expectedBaseline` 传给后端 `write_workspace_text`，后端在磁盘文本级做冲突检测（AC-1：磁盘 ≠ 基线 → `Conflict` 拒绝且不写盘），前端冲突条提供「覆盖保存」（force=true 跳过基线）与「重新加载」（丢弃本地编辑）。保存成功更新磁盘基线并推进 `saveAnchorToken` 使编辑锚点对齐；保存失败保留 dirty 与用户编辑。编辑中 agent 工具写入（touchVersion 递增）走探测路径：用户有未保存编辑 → 上报冲突不静默覆盖；无编辑 → 安全刷新。编码/大文件策略：GBK 原编码回写、UTF-8 BOM 保留、`MAX_SAVE_BYTES=256KB` 超限文件保持只读（编辑按钮禁用）且后端二次拒绝。

### D-03：统一 Diff 渲染能力

- Diff 布局采用自动模式：宽度足够时左右对比，窄窗口使用 inline。
- 用户可以手动切换自动、左右对比、inline；每个文件 tab 记忆选择。
- 自动切换不得丢滚动位置、选区或当前 hunk。
- `working-diff` 比较“最近一次成功保存到磁盘的版本”与当前未保存编辑内容；保存成功后更新基线，保存失败不更新。
- `git-diff` 默认按 SCM 入口选择 scope，并允许切换：未暂存 `Index ↔ Working Tree`、已暂存 `HEAD ↔ Index`、全部 `HEAD ↔ Working Tree`。
- 净增/净减是统一 diff model 的过滤视图，保留上下文、行号、hunk 与 scope；不生成脱离 diff 的独立文本。

实施方案成熟度：**已有产品和渲染方向；当前 FileSheet 尚无完整编辑器，`working-diff` 是否本轮启用仍未决策。**

### D-04：Views 按路径聚合 Agent 文件活动

- 同一路径默认只显示最近一次触碰。
- 用户可展开查看该路径的历史触碰事件。
- Views 不承担 Git status/diff 入口；点击路径进入同一文件 tab 的普通视图。

实施方案成熟度：**已有明确措施。**

## 并行执行元数据

```yaml
formal_id: ISSUE-08
status: 已交付（方案已写入）
lane: frontend-file
priority: P1
stage: consumer
size: L
dependencies: ["01-A", "07-A"]
blocks: []
likely_modify: ["src/sheets/file/", "src/workspaceStore.ts", "src-tauri/src/workspace_cmds.rs"]
do_not_modify: ["working-diff 必须以真实编辑/save/conflict 证据验收"]
execution_rule: "先完成任务卡依赖，再领取本 Issue 的 ready slice；跨 Lane 变更必须经 contract/checkpoint。"
```

> 此处是 Harness 的机器可读入口。Issue 级状态不等于所有 slice 完成；以 `harness/queue.json`、任务卡和 checkpoint 为准。

### D-05：本轮实现完整文件编辑能力并启用 working-diff

- ISSUE-08 本轮范围包含 FileSheet 的真实文本编辑、dirty 状态、保存和 `working-diff`。
- `working-diff` 基线为最近一次成功保存到磁盘的内容，目标为当前未保存编辑内容。
- 保存成功后更新磁盘基线并清理对应 dirty diff；保存失败不得更新基线或清除用户编辑。
- 外部程序修改磁盘文件时必须检测并进入明确的冲突/重新加载流程，不得静默覆盖用户编辑。
- 编辑、保存、FileViewHost、Git diff、净增和净减共用同一文件 tab identity 与状态栏；不得另建平行编辑页面。
- 文本选择、发令栏、文件读取截断和现有只读行为必须兼容迁移。

实施方案成熟度：**已有产品与行为边界；编辑器选型、保存 IPC、外部变更检测、冲突 UI、编码/换行处理和大文件策略尚无代码级方案。**

## 原始问题记录

原问题编号：#6
严重度：P2
状态：已交付（方案已写入）

问题现象：
宫木云汇报：
“视图和 SCM 分区功能部分重叠，应该拆分功能域；可能需要拓展功能来完善 Git 分区，并沿用文件视图的逻辑，而不是新建一个‘变更预览’视图。”

产品决策：
- SCM = 完整 Git 工作台。
- 视图 = Agent 最近触碰文件，并在现有文件编辑器中打开。

问题根因：
当前 `GitPanel` 和 `ViewsPanel` 都调用 `git_status` 并分别渲染 Git 变更列表；二者点击后都把 `activeDiff` 交给 FileSheet 主区，并使主区切换到独立 `DiffView`。因此 SCM 与视图同时承担“Git 变更入口”，而“视图”没有形成独立的 Agent 文件活动域；同时 diff 采用独立预览组件，绕开了现有文件 tab、读取、选择和状态栏链路。

证据等级：L2 源码证据。

相关源代码：
- `G:/Project/prism-desktop/src/sheets/file/GitPanel.tsx:68-135`
  - SCM 已包含 staged、working tree 和 commits，点击状态条目调用 `onOpenDiff`。
- `G:/Project/prism-desktop/src/sheets/file/ViewsPanel.tsx:22-61`
  - Views 再次调用 `gitStatus`，再次渲染 `CHANGES / DIFF`。
- `G:/Project/prism-desktop/src/sheets/file/ViewsPanel.tsx:63-76`
  - Agent touched files 只是静态行，不能打开文件。
- `G:/Project/prism-desktop/src/sheets/file/FileSheetView.tsx:35,80-98`
  - SCM/Views 共用 `activeDiff`，主区命中后渲染独立 `DiffView`，而不是现有 `FileTabView`。
- `G:/Project/prism-desktop/src/sheets/file/FileSheetView.tsx:50-67,99-125`
  - 现有文件视图已经具备 openTabs、activeFile、文件读取、selection、DispatchBar 和状态栏链路，可直接复用。

解决方案：

方案 A（推荐，按产品决策拆域）：
- 改动位置：`ViewsPanel.tsx`、`GitPanel.tsx`、`FileSheetView.tsx`、`FileTabBar.tsx`、`FileTabView.tsx`、`workspaceStore.ts` 的 touchedFiles 数据消费；后端 Git command 按完整工作台需要扩展。
- 具体改法：
  1. ViewsPanel 删除 `gitStatus`、`entries`、`activeDiff`、`onOpenDiff`、`onCloseDiff` 全部 Git 逻辑，只读取 `touchedFiles[source]`。
  2. Agent touched file 行改为可点击按钮；点击调用 FileSheet 已有 `openTab(path)`，进入同一个 `FileTabView`，不创建新的“变更预览”主视图。
  3. Views 按最近触碰时间倒序显示 path、toolKind、时间；同一路径是否保留多条事件或聚合为一条可在 selector 层定义。推荐默认按路径去重，显示最后触碰时间，并可展开事件历史。
  4. SCM 独占 Git 业务：staged、unstaged、untracked、commit history、branch/repository summary；后续扩展 stage/unstage、discard、commit、branch 切换等 command 时只进入 SCM。
  5. Git diff 不再由顶层 `activeDiff ? <DiffView>` 替换整个文件编辑器。推荐给现有 tab 模型增加 view mode：
     ```ts
     type FileTab = { path: string; mode: 'file' | 'diff'; staged?: boolean }
     ```
     SCM 点击变更文件时打开 diff-mode tab；普通文件和 Views 点击打开 file-mode tab。两种 mode 共享 tab strip、路径、关闭、状态栏和主区壳。
  6. `FileTabView` 保持普通文件读取；diff-mode 由同一 tab host 内调用 `git_diff` 渲染，而不是在 FileSheet 顶层创建平行页面。若短期不改 tab schema，至少把 DiffView 包入统一 `FileTabView` host，并复用 tab/status bar。
- 影响面：SCM 与 Views 的功能职责会明确改变；Views 不再显示 Git status，只显示 Agent 文件活动。SCM 的 diff 仍保留，但入口和展示并入现有文件 tab 逻辑。
- 验证方式：
  1. Views 不调用 `git_status`，只显示当前 source 的 touched files。
  2. 点击 Views 文件后出现在现有 tab strip，显示普通文件内容。
  3. SCM 点击变更文件打开 diff-mode tab，关闭/切换行为与普通文件一致。
  4. 同一路径可同时存在 file-mode 与 diff-mode 时，singleton key 必须区分 mode；若不允许同时存在，应明确定义复用规则。
  5. source 切换后 Views/SCM 都只显示新 source 数据。
  6. 无 source 时两个分区均显示选择工作区引导。
- 风险与取舍：需要扩展当前 `openTabs: string[]` 持久化 schema；推荐升级为 versioned tab record，而不是继续把 diff 状态塞入顶层临时 state。

重构方案：
将 FileSheet 主区统一成 `FileViewHost`：

```text
左栏入口
  ├─ Files/Search/Views → open file tab
  └─ SCM → open diff tab

FileViewHost
  ├─ FileTabBar
  ├─ file mode → FileTabView
  └─ diff mode → GitDiffView
```

禁止分区直接替换 FileSheet 主区，所有文件相关展示都通过统一 tab/view host。

---

### 源码复核后的实施细化

1. 先把 `ViewsPanel` 的 `gitStatus/entries/activeDiff` 完全移除，仅消费 `workspaceStore.touchedFiles[source]`；touched file 行调用已有 `openTab(path)`。
2. 再定义 versioned tab record，例如 `{version:2,tabs:[{path,mode:'file'|'diff',staged?}],activeKey}`；旧 `openTabs` string[] 读取时迁移为 file mode。
3. `FileSheetView` 将 `activeDiff` 从顶层临时 state 下沉为 tab host 的 view mode；`FileTabBar` key 必须区分 path+mode，避免同一路径 file/diff 互相覆盖。
4. SCM 保留 status/history，并把 `git_diff` 结果放入统一 `FileViewHost`；不要先删除现有 `DiffView`，先改挂载位置和关闭/切换语义。
5. 后端 workspace/Git 仍调用 `require_runtime()`，因此 #13 单活方案下必须先增加 source/Agent 一致性 guard；并行方案则需要显式 agentId command。

可行性：中高。前端结构可落地，但 tab 持久化迁移和后端 Agent 路由是实际依赖，不能按纯 UI Bug 交付。

---


## 逐项验收清单

### 6.9 问题 #6：SCM / Views 拆域与统一 FileViewHost

#### 等级 1：测试通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| Views 去 Git 化 | Views 不调用 `git_status`，只消费 touched files | `src/sheets/file/ViewsPanel.tsx` component tests | [ ] |
| versioned tab schema | 旧 `openTabs:string[]` 可迁移为 file-mode tabs；损坏数据回退为空 | `src/sheets/file/fileSheetState.ts` / tab persistence tests | [ ] |
| file/diff tab identity | 同路径 file/diff 按拍板规则并存或复用，关闭/切换不串 mode | `FileTabBar.tsx`、`FileViewHost` tests | [ ] |
| SCM diff | SCM 点击变更打开 diff-mode tab，不在顶层替换整个主区 | FileSheet integration tests | [ ] |
| 真实编辑/保存 | 编辑开关 + 受控 textarea；保存带 expectedBaseline 走基线校验；成功更新磁盘基线、失败保留 dirty | `workspaceWrite.ts` / `FileTabView.edit` / `FileViewHost.save` tests | [✓] I08-A-FE-02 |
| 外部修改冲突流程 | 外部修改不静默覆盖：保存拒绝出冲突条，覆盖保存（force）/重新加载（丢本地编辑） | `FileViewHost.save` tests + `workspace.rs` write_text 冲突测试 | [✓] I08-A-FE-02 |
| working-diff | 基线 vs 未保存编辑的 `+N −M` 统计与变更预览面板；保存后基线推进、dirty 清除 | `workingDiff` / `FileViewHost.save` tests | [✓] I08-A-FE-02 |
| 编码/大文件策略 | GBK 原编码回写、UTF-8 BOM 保留、超 256KB 保持只读不可编辑 | `workspace.rs` write_text 测试 / `FileViewHost.save` truncated 测试 | [✓] I08-A-FE-02 |

#### 等级 2：前端网页验收通过（仅限前端）

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| Views 行为 | 只显示 Agent 最近触碰文件；点击后进入现有普通文件 tab | `http://localhost:5173/` → File Sheet → 视图 | [ ] |
| SCM 行为 | staged/working tree/history 保留；点击文件打开 diff tab | `http://localhost:5173/` → File Sheet → SCM | [ ] |
| 统一主区 | file/diff 共用 tab strip、关闭、切换、路径和状态栏壳 | `http://localhost:5173/` → File Sheet 主区 | [ ] |

#### 等级 3：真实应用验收通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 真实 touched file | Agent 实际读/改文件后，Views 出现对应路径，点击打开真实内容 | 真实应用 → Agent 对话 → File Sheet → 视图 | [ ] |
| 真实 Git diff | SCM 读取真实仓库 status/history，diff tab 内容与命令行 Git 一致 | 真实应用 → File Sheet → SCM；目标仓库 | [ ] |
| source 切换 | 切换会话后 SCM/Views/tab 不显示旧工作区数据 | 真实应用 → File Sheet | [ ] |
| 真实编辑/保存 | 真实文件编辑保存后磁盘内容更新、dirty 清除；GBK/BOM 回归无乱码 | 真实应用 → File Sheet → 编辑/保存（handoff I08-A-FE-02 L3 步骤 1/3） | [ ] 待开阳 |
| 真实冲突流程 | 外部程序改文件后保存被拒、冲突条覆盖/重新加载生效；agent 工具写入不静默覆盖用户编辑 | 真实应用 → File Sheet → 编辑 + 外部修改（handoff I08-A-FE-02 L3 步骤 2/4） | [ ] 待开阳 |

## 施工日志

| 2026-08-09 | 拍板决策同步 | 已将本轮已确认的产品决策与当前实施成熟度写入“已拍板决策”。未形成措施的内容明确标注为仅有决策。 | 关联未决策项见 `未决策项.md` |
| 日期 | 类型 | 记录 | 证据/备注 |
|---|---|---|---|
| 2026-08-09 | 文档拆分 | 从 `docs/release-issues.md` 拆分为 `ISSUE-08`；保留原问题记录、追加调查、修复记录与三级验收内容。 | 本文件生成于 Issue Library 初始化 |
| 2026-08-09 | 产品拍板 | ISSUE-08 本轮实现完整文件编辑、dirty/save/conflict，并正式启用 working-diff。 | 对应未决策项：FileSheet 编辑能力 |
|  |  |  |  |


## 本轮源码核验与可验收子任务（2026-08-09）

### 逐条源码核验矩阵

| 原主张 | 判定 | 当前源码证据 | 方案修正 |
|---|---|---|---|
| Views 已有 touchedFiles 数据源 | 属实 | `src/workspaceStore.ts:60,164-166`；`src/sheets/file/ViewsPanel.tsx:19-20,64-67` | 移除 Views 的 Git 职责，只保留 Agent 活动。 |
| 统一 FileViewHost/真实编辑已完成 | 不属实 | `FileSheetView.tsx:35,96-97` 仍用顶层 `activeDiff`；未发现完整 save/conflict IPC | 分成 tab identity 迁移和编辑/save/working-diff L3 vertical slice。 |


> 本节是本轮对当前源码的增量审计与执行切分。原编号只用于追溯；以下 task id 才是 Harness v2 的执行单位。

### 核验结论
- 🟡 Views 已消费 `touchedFiles`，但 `FileViewHost`/真实编辑保存能力尚未形成完整链路；原方案必须拆为只读域迁移与真实编辑 vertical slice，不能合并宣称完成。证据：`src/sheets/file/FileSheetView.tsx:35-101`、`src/workspaceStore.ts:60-166`。

### 子任务清单

| Task ID | 类型 | 归属 | 依赖 | 验收标准 | 最低证据 |
|---|---|---|---|---|---|
| `I08-A-FE-01` | FE | A | I07-A-FE-02 | Views 只消费 touchedFiles 并统一 file/diff tab identity；SCM 独占 Git，Views 不维护 gitStatus；同路径 file/diff tab 不互相覆盖。 | L1 |
| `I08-A-BE-01` | BE | A | I01-A-BE-01 | workspace/Git source 与 runtime 一致性 guard；source/Agent 不一致返回错误，不回退当前 runtime。 | L1 |
| `I08-A-FE-02` | FE | A | I08-A-FE-01, I08-A-BE-01 | 真实编辑/save/working-diff vertical slice；保存成功更新磁盘基线，失败保留 dirty；外部修改进入冲突流程，不静默覆盖。 | L3 |
| `I08-B-FX-01` | FX | B | I08-A-FE-01 | FileViewHost 动效与沉浸层接入；只通过已冻结 host/selector 接入，不改业务状态；低性能与 reduced-motion 降级。 | L2 |

### 本轮施工日志

| 2026-08-09 | 源码核验 + 任务切分 | 已对照当前源码建立证据结论；按一张卡一个独立可验收结果切分，B 视觉任务仅在基座/契约明确后进入。 | `docs/Issue Library/harness-v2/` |
