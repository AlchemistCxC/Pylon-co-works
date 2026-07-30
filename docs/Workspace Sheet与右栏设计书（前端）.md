# Workspace Sheet 与右栏设计书（前端）

> 项目：Pylon / Prism Desktop
> 项目路径：`G:\Project\prism-desktop`
> 设计范围：顶部 Workspace Sheet、Sheet Launcher、Agent 工作现场、右栏 Context Inspector、首批工具 Sheet
> 基线日期：2026-07-30
> 本文是产品与前端架构设计，不代表功能已经实现。

> **状态与交接边界**：本文只定义产品目标和前端架构，不维护任务进度、commit、当前状态或后端依赖编号。所有实施状态、当前子任务、阻塞条件和接管规则，以 `docs\前端开发与交接手册.md` 为唯一真值；后端能力状态以 `docs\后端开发与交接手册.md` 为准。Skill 仅作为路径与工具参考。

## 一、设计目标

当前顶部只有 `Peri / Prism` 两个固定按钮，存在四个问题：

1. `App.tsx` 使用 `'peri' | 'prism'` 硬编码页面类型，无法承载新增 Agent 和工具页面。
2. 顶栏高度仅 32px，Tab 从窗口最左侧开始，未与 Sidebar 右边界及终端主区域对齐。
3. Agent 切换目前围绕单一全局 `activeAgent`，不能自然表达多个 Agent 工作现场。
4. 右栏已经接入 Workspace 和 Logs，但仍以“功能页集合”组织，缺少稳定的产品职责。

本设计将 Pylon 的主界面划分为四层：

```text
顶部 Workspace Sheet：切换工作台
左侧 Sidebar：当前 Agent Sheet 下的 Profile / Session 导航
中央主区域：完成当前任务
右侧 Context Inspector：查看当前任务的上下文、活动与变化
```

核心原则：

- Sheet 用于持续操作、独立导航、大面积展示和现场恢复。
- 右栏用于当前 Sheet 的上下文摘要与快捷入口。
- Dialog 用于短暂创建、设置与确认。
- 不因为 Sheet 可扩展，就把所有功能都做成 Sheet。

## 二、当前源码基线

### 2.1 已存在能力

- `src/App.tsx`
  - 已通过 `list_agents` 读取真实 Agent 列表。
  - 已从 store 读取 `activeAgent`，顶部 Agent 名称不是必须硬编码为 Peri。
  - 当前 `activeTab` 仍是 `'peri' | 'prism'`。
- `src/components/PrismSheet.tsx`
  - 已存在完整管理页面骨架。
  - 当前组件内部仍有演示数据和“尚未接入 Prism API”提示。
- `src/components/RightPanel.tsx`
  - Workspace 已调用 `list_workspace_entries`、`read_workspace_text`。
  - Logs 已调用 `list_runtime_logs`。
  - 仍有两个未定义的 Reserved Tab。
- `src/store.ts`
  - 已有 Agent 列表、当前 Agent、Agent status、Session 集合及按 source 隔离的运行时状态。
  - 尚无 Workspace Sheet 集合与每 Sheet 的现场状态。
- `package.json`
  - 已有 Radix Dropdown、Tabs、Dialog、`cmdk`、`@dnd-kit`、`react-diff-viewer`，不需要为了首期 Sheet 系统新增 UI 依赖。

### 2.2 现状不能被误报为已完成

- 真实 Agent 名称已可读取，不等于多 Agent Sheet 已实现。
- Workspace 文件预览已接入，不等于完整 File Sheet 已实现。
- RuntimeLogHub 已接入，不等于 Runtime Sheet 已实现。
- `PrismSheet` 页面存在，不等于当前工作区中的 Prism 前端管理链路已完成。
- Reserved Tab 只是占位，不是产品能力。

## 三、统一信息架构

### 3.1 Sheet 类型

```ts
type WorkspaceSheet =
  | AgentSheet
  | PrismManagerSheet
  | ChangesSheet
  | GitHistorySheet
  | RuntimeSheet
  | FileSheet
  | DiffSheet
  | AgentManagerSheet
  | RunsSheet
  | TerminalSheet
  | PetManagerSheet
```

基础字段：

```ts
interface WorkspaceSheetBase {
  id: string
  kind: WorkspaceSheetKind
  title: string
  closable: boolean
  pinned?: boolean
  createdAt: number
  lastActiveAt: number
}
```

Agent Sheet：

```ts
interface AgentSheet extends WorkspaceSheetBase {
  kind: 'agent'
  agentId: string
  activeProfileId: string
  activeSessionId: string | null
  rightPanelTab: RightPanelTab
}
```

工具 Sheet：

```ts
interface ToolSheet extends WorkspaceSheetBase {
  kind: 'prism-manager' | 'changes' | 'git-history' | 'runtime' | 'file' | 'diff'
  singletonKey?: string
  scope?: {
    source?: string
    workspaceRoot?: string
    relativePath?: string
    commit?: string
  }
}
```

### 3.2 单例和多实例

默认单例：

- Prism 管理
- Agent 管理
- 宠物管理
- 当前 workspace 的 Changes
- 当前 runtime scope 的 Runtime

允许多实例：

- Agent
- File
- Diff
- Git History
- Terminal
- Runs detail

首期 Agent 采用“同一 Agent 一个 Sheet”。不在 P0 阶段设计同一 Agent 多开，避免 Agent runtime、Session、标题和关闭语义失控。

### 3.3 Sheet 与 Session 层级

```text
Workspace
└── Agent Sheet
    ├── Agent runtime
    ├── active Profile
    ├── active Session
    ├── Sidebar Session 列表
    ├── 输入草稿与滚动位置
    └── 右栏状态
```

切换 Agent Sheet 时，需要恢复该 Sheet 上次的：

- Agent
- Profile
- Session
- 输入草稿
- Chat 滚动位置
- 右栏开关与当前 Tab

不能继续只依赖一个全局 `activeSession` 和一个全局 `activeAgent` 表达所有工作现场。

## 四、顶栏设计

### 4.1 几何结构

```text
┌────── Sidebar 对齐区 ──────┬──────── Workspace Tabs ────────┬── 固定操作 ──┬── 窗口控制 ──┐
│ ☰  Pylon                  │ ● Peri ×  Changes ×  Prism ×  │ ＋  ⌄       │ Panel ⚙ ─ □ × │
└───────────────────────────┴───────────────────────────────────┴────────────┴───────────────┘
```

设计约束：

- 顶栏目标高度：42–44px。
- 左侧区宽度跟随 `--sidebar-width`。
- Sheet Tab 起点与终端主区域左边缘对齐。
- 窗口控制区固定在最右。
- Tab 容器独立横向滚动。
- `＋` 和 `⌄` 固定可见，不随 Tab 滚走。
- Sidebar 折叠后，左侧区收敛为仅保留折叠按钮的窄区。

### 4.2 视觉语言

- 使用 JetBrains Mono。
- 不使用浏览器式大圆角胶囊。
- Tab 为扁平结构，active 状态使用低强度背景与 2px accent underline。
- Tab 间允许极淡分隔线。
- Agent 状态点表达连接状态；工具 Sheet 不显示运行状态点。
- 关闭按钮默认弱化，hover/focus 时增强。
- 长标题省略，不允许挤压固定操作和窗口控制。

Agent 状态点：

| 状态 | 表达 |
|---|---|
| connected | 绿色 |
| connecting / reconnecting | 黄色 |
| disconnected | 灰色 |
| crashed / error | 红色 |

### 4.3 `＋`：Sheet Launcher

`＋` 是通用 Sheet Launcher，不是“新建 Agent”。

内容分组：

```text
搜索要打开的页面…

最近使用
Agent
  Peri
  Riccati
  Vesper
  创建 Agent…
工具
  Changes
  Git History
  Runtime
  打开文件…
  Prism 管理
  宠物管理
管理
  Agent 管理
  管理 Workspace…
```

交互：

- 打开后自动聚焦搜索框。
- 支持上下键、Enter、Esc。
- 搜索匹配标题、类型、关键词。
- 已打开的单例 Sheet 直接聚焦。
- 已打开的 Agent Sheet 直接聚焦。
- 未实现能力必须显示“开发中”或不展示，不能打开假页面冒充可用功能。

推荐实现：使用现有 `cmdk` + Radix Popover/Dropdown 语义，面板贴近 `＋` 展开，不使用居中的全屏 Command Palette。

### 4.4 `⌄`：Workspace 管理菜单

`⌄` 不重复 Launcher，负责当前 Workspace 和 Tab 管理：

```text
切换到 Sheet           >
重新打开已关闭 Sheet   >
关闭当前 Sheet
关闭其他 Sheet
关闭右侧 Sheet
──────────────────────
固定当前 Sheet
复制 Sheet
移动到新窗口           开发后置
──────────────────────
保存 Workspace         开发后置
恢复默认 Workspace
```

Tab 右键菜单复用单 Sheet 操作：固定、复制、关闭、关闭其他、关闭右侧。

## 五、右栏设计：Context Inspector

### 5.1 产品定义

右栏的最大价值是：

> 不离开当前 Agent 对话，就能确认它正在什么环境里、做了什么、改了什么，以及哪里出了问题。

它不是第二个应用区，也不是小型 Sheet 仓库。

右栏最终保留四个入口：

```text
Inspector | Workspace | Activity | Changes
```

删除 `Reserved 1 / Reserved 2`。

### 5.2 Inspector

展示当前 Agent Sheet 和 Session 的摘要：

```text
AGENT
Peri
Connected

SESSION
修复 Sheet 顶栏
source: local-a82f

RUNTIME
Mode        default
Model       deepseek-v4-flash
Context     42%
Generating  18s

WORKSPACE
G:\Project\prism-desktop
Branch      main
Changes     4
Errors      1
```

快捷入口：

- 重连 Agent
- 打开 Session 设置
- 复制 source
- 打开 Changes Sheet
- 打开 Runtime Sheet
- 在系统中显示工作目录

右栏只显示摘要，不承载复杂编辑。

### 5.3 Workspace

保留当前已接入的目录树与文本读取能力，但修改使用方式：

- 单击文件：右栏二级预览。
- 双击文件或点击“打开”：创建 File Sheet。
- 文件有变更标记时点击标记：创建 Diff Sheet。
- 右键：复制路径、加入当前 Agent 上下文、在系统中显示。

二级预览采用：

```text
← Workspace      App.tsx
──────────────────────
文件内容
```

不再让目录树和完整 `<pre>` 长期上下争抢高度。

### 5.4 Activity

将当前“日志”重构为当前 Session 的活动摘要：

```text
12:41:03  Read    src/App.tsx
12:41:08  Search  activeTab
12:41:21  Edit    src/App.css
12:41:25  Build   running
12:41:32  Build   failed
```

点击行为：

- 文件事件：打开 File/Diff Sheet。
- 错误事件：打开 Runtime Sheet 并定位。
- 构建事件：查看输出。
- Agent 状态事件：打开 Agent Inspector/管理。

Activity 不是完整原始日志查看器。原始日志查询、过滤和导出属于 Runtime Sheet。

### 5.5 Changes

右栏只展示摘要：

```text
CHANGES 4
M src/App.tsx        +42 -8
M src/App.css        +31 -12
? src/sheets.ts      +96

[打开 Changes]
```

不在 260px 右栏内显示完整双栏 Diff。

## 六、首批 Sheet 产品定义

### 6.1 Agent Sheet

用途：当前 Agent 的完整工作现场。

必须保留：

- Agent 状态
- Profile/Session 导航
- Chat
- Control Center
- 输入草稿
- 右栏现场

### 6.2 Prism 管理 Sheet

用途：Bot、场景、World Book、Blocks、调试、系统管理。

规则：

- 单例。
- Sheet 可打开。
- 未接入功能局部标注开发中，不把整个 Sheet 禁用。
- 后续接真实 Prism command 时，禁止继续保留静态 mock 作为业务结果。

### 6.3 Changes Sheet

用途：审查 Agent 刚刚修改了什么。

内容：

- Working Tree / Staged / Untracked
- 文件列表
- 文件 Diff
- 新增/删除行数
- 暂存/取消暂存
- 提交前检查摘要

危险操作如丢弃修改需要明确确认，并应后置到后端安全契约完成后启用。

### 6.4 Git History Sheet

内容：

- Commit 时间线
- Commit 详情
- Commit 文件列表
- Commit Diff
- Branch/Tag
- Commit 对比
- 文件历史

### 6.5 Runtime Sheet

内容：

- Logs
- Events
- Processes
- ACP Traffic
- Errors

支持：

- level/source/session/search 过滤
- 暂停自动滚动
- 清理和导出
- 从右栏 Activity 定位到具体事件

### 6.6 File / Diff Sheet

第一阶段只读：

- File Sheet：完整文本、语法高亮、路径、截断状态。
- Diff Sheet：统一 diff 与 split diff 切换、文件状态、行号。

不在首期承诺完整代码编辑器。

## 七、按优先级划分的前端任务

## P0：Workspace 基础与真实 Agent Sheet

目标：替换硬编码 `Peri / Prism`，建立可持续扩展的 Sheet 壳。

任务：

1. 新增 Sheet 类型、registry、normalize 与 reducer/action。
2. 将 `App.tsx` 的 `activeTab` 替换为 `activeSheetId`。
3. 建立 `openSheet / focusSheet / closeSheet / closeOthers / reopenSheet`。
4. 建立 Agent Sheet，并使用真实 `list_agents` 数据。
5. 保存每个 Agent Sheet 的 active Profile、active Session、右栏状态。
6. 顶栏改为 42–44px，并与 Sidebar/终端主区域对齐。
7. 实现 `＋` Launcher 和 `⌄` Workspace 菜单。
8. 将 Prism 管理注册为单例 Tool Sheet。
9. 保持当前 Settings、窗口控制、RightPanel、ControlCenter 行为不被破坏。

P0 不包含：

- Git 后端能力
- 多窗口
- 同一 Agent 多开
- Workspace 云同步

完成标准：

- 新增/关闭/切换 Agent Sheet 不串 active Session。
- Agent status 点跟随真实状态。
- 重复打开 Agent/Prism 单例时聚焦现有 Sheet。
- 顶栏在 1024、1440、1600 宽度下不覆盖窗口控制。
- reload 后 Sheet 集合可恢复；损坏持久化数据回退到默认 Agent Sheet。

## P1：右栏重构与已有能力升级

目标：把历史右栏收敛为 Context Inspector。

任务：

1. Reserved Tab 删除。
2. 新增 Inspector。
3. Workspace 改为树/二级预览模式。
4. Logs 改为 Activity 摘要。
5. 新增 Changes 摘要入口；没有后端时显示明确未接入状态。
6. 右栏当前 Tab 按 Agent Sheet 保存。
7. 右栏所有“打开完整页面”动作统一调用 Sheet registry。
8. 文件双击打开 File Sheet；首期复用现有 `read_workspace_text`。
9. 新增 Runtime Sheet，消费现有 `list_runtime_logs` 和后续 `pylon:runtime-log`。

完成标准：

- 右栏切换 Agent Sheet 后立即切换 scope，不显示上一 Agent/Session 数据。
- Workspace 文件预览不会长期挤压目录树。
- Activity 只显示摘要，Runtime Sheet 显示完整日志。
- 关闭右栏不丢失中央工作现场。

## P2：开发工作台 Sheet

目标：补齐代码审查和历史定位能力。

任务：

1. Changes Sheet。
2. Diff Sheet。
3. Git History Sheet。
4. 文件状态 badge 与右栏 Changes 摘要。
5. Commit/branch/path 深链接到 Sheet。
6. Agent 管理 Sheet，用于复杂 Agent 配置与状态诊断。
7. PrismSheet 从演示数据迁移到真实 command adapter。

完成标准：

- 只读 Git 状态、Diff、History 有真实后端数据。
- Diff 大文件有截断/分页状态，不冻结 UI。
- 未获得后端写操作能力前，前端不显示可用的 stage/discard/commit 按钮。
- Prism 管理页面不再用静态数组冒充真实数据。

## P3：扩展与高级工作流

任务：

- Runs Sheet：后台任务、子 Agent、进程和结果。
- Terminal Sheet：真实 PTY 后再实现。
- Pet Manager Sheet：透明宠物的完整管理和统计。
- Sheet 拖拽排序、固定、复制。
- 保存多个 Workspace Layout。
- 移动 Sheet 到新窗口。
- 插件注册自定义 Sheet。
- 同一 Agent 多开及独立 runtime 的产品决策。

P3 不得阻塞 P0/P1。

## 八、前端状态与持久化

建议使用独立持久化 key，不写入主题 `pylon-theme`：

```text
pylon-workspace-sheets
```

建议 schema：

```ts
interface WorkspaceSheetStateV1 {
  version: 1
  activeSheetId: string
  sheets: PersistedWorkspaceSheet[]
  recentlyClosed: PersistedWorkspaceSheet[]
}
```

不持久化：

- React component
- function/action
- loading/error promise
- Tauri window handle
- 运行中 request generation
- 大块文件内容和日志列表

恢复规则：

1. 丢弃未知 kind。
2. 去重 singletonKey。
3. 丢弃无效 Agent ID 或转为 disconnected placeholder，再由 `list_agents` 校验。
4. activeSheetId 无效时选择第一个可用 Agent Sheet。
5. 至少保留一个 Agent Sheet；最后一个 Agent Sheet 关闭时回到 Launcher/空工作区，而不是崩溃。

## 九、组件建议

```text
src/workspace-sheets/
  sheetTypes.ts
  sheetRegistry.ts
  sheetState.ts
  sheetPersistence.ts
  SheetHost.tsx
  WorkspaceTitlebar.tsx
  SheetTabStrip.tsx
  SheetLauncher.tsx
  WorkspaceMenu.tsx

src/components/right-panel/
  InspectorPanel.tsx
  WorkspacePanel.tsx
  ActivityPanel.tsx
  ChangesSummaryPanel.tsx

src/sheets/
  AgentSheetView.tsx
  PrismManagerSheetView.tsx
  RuntimeSheetView.tsx
  FileSheetView.tsx
  DiffSheetView.tsx
  ChangesSheetView.tsx
  GitHistorySheetView.tsx
```

`sheetRegistry` 是 Sheet 元数据单一真值源：

```ts
interface SheetDefinition {
  kind: WorkspaceSheetKind
  label: string
  singleton: boolean
  launcherGroup: 'agent' | 'tool' | 'management'
  available: (context: SheetAvailabilityContext) => boolean
  render: (sheet: WorkspaceSheet) => React.ReactNode
}
```

不要在 Titlebar、Launcher、Host 三处各写一套 Sheet 分支。

## 十、前后端边界

前端可以独立完成：

- Sheet state、顶栏、Launcher、菜单、持久化。
- Agent/Prism/File/Runtime 的页面壳。
- 右栏 Inspector 信息编排。
- 使用已有 Workspace/Logs/Agent command。

必须等待后端契约：

- Git status/diff/history。
- stage/unstage/discard/commit。
- 真实 PTY Terminal。
- 进程与 Runs 聚合。
- Prism API 的最终 DTO 和错误语义。
- 打开系统文件管理器等 shell 能力的安全边界。

## 十一、验证矩阵

### 结构测试

- registry kind 唯一。
- singleton 不重复。
- close/focus/reopen 顺序。
- Agent Sheet 独立 active Session。
- 持久化 round-trip 和损坏数据回退。

### 浏览器 UI

尺寸：

- 1024×768
- 1440×900
- 1600×900

检查：

- Sidebar 与 Tab 起点对齐。
- Tab 溢出不覆盖 `＋/⌄/窗口控制`。
- Launcher 键盘操作。
- 右栏打开/关闭不改变中央控件几何。
- 暗色和亮色可读性。

### Tauri 运行时

- list_agents、agent_status、switch_agent。
- Workspace list/read。
- Runtime log list/event。
- Agent Sheet 切换与真实 Agent 生命周期。

### 最终工程验证

```bash
npm run test:frontend
npm run build
git diff --check -- src docs
```

## 十二、禁止事项

- 不把 Sheet ID、Agent ID、Session ID、source、periId 混为一层。
- 不在 Sheet 切换时无条件销毁其他 Agent Sheet 的前端现场。
- 不在前端伪造 Git、Prism、Runtime 业务结果。
- 不把完整日志、Diff、Git History 塞进右栏。
- 不把 Settings、创建表单等短流程强制改成 Sheet。
- 不为占位页保留 Reserved Tab。
- 不把 Sheet 集合写进主题持久化。
- 不恢复 32px 小胶囊顶栏。

## 十三、执行顺序摘要

```text
P0  Workspace Sheet 基础 → 真实 Agent Sheet → 顶栏/Launcher → Prism 单例
P1  Inspector → Workspace 二级预览 → Activity → Runtime/File Sheet
P2  Changes/Diff → Git History → Agent 管理 → Prism 真实数据
P3  Runs/Terminal/Pet → 多窗口/插件/多 Workspace
```
