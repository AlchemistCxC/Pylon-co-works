# 前端 Bug 修复交接

## 1. 任务摘要

本批次依据 `docs/buglist.md` 连续修复 BUG-01 至 BUG-05，共 5 个独立根因，每项均已单独提交。

当前剩余清单项为 BUG-06：SessionSettings 信息层级与危险操作区 UI 重排。该项属于 P3 UI 优化，不是功能链路 Bug，留给下一位 coder 接管。

本批次未修改后端、依赖版本和既有产品设计。

## 2. 审计基线

- 项目：`G:\Project\prism-desktop`
- 分支：`main`
- 开始基线：`8ba5d72 feat(pet): 生成时概率触发平板敲代码动画`
- 当前源码 HEAD：`7621fe9 fix(agent): 锁定切换交互并保持失败状态`

开始时已有且本批次未触碰的工作区内容：

```text
M agents.yaml
D docs/AUDIT-BUGFIX-GUIDE.md
D docs/CODER-PROMPT.md
M src-tauri/src/acp.rs
?? docs/buglist.md
?? docs/交接工作规范.md
?? docs/功能开发方向.md
?? 开发文档/前端交接清单.md
```

不得恢复、覆盖、删除或纳入后续提交。

## 3. 已完成修复

### BUG-02：空 replay 覆盖本地历史缓存

Commit：

```text
f82d7cf fix(chat): 保留空 replay 时的本地历史缓存
```

根因：

- `load_persisted_session` invoke 成功时无条件采用 replay 数组。
- replay 暂时为空会覆盖并删除有效缓存。
- replay 判断只依赖可选 event meta，历史 user event 可能误启动实时 generation。

修改：

- `src/components/chat/ChatView.tsx`
- `src/components/chat/replayState.ts`
- `scripts/test-replay-state.mts`

不变量：

- load 生命周期本身可作为 replay 判据。
- 空 replay 保留本地缓存。
- replay user event 不启动实时 spinner。

### BUG-01：上下文统计串会话

Commit：

```text
1505eec fix(runtime): 按 source 隔离会话上下文统计
```

根因：token、cache 和 commands 使用应用级全局单例，但事件和 UI 实际按 session source 工作。

修改：

- `src/store.ts`
- `src/components/chat/sessionRuntime.ts`
- `src/components/chat/ChatView.tsx`
- `src/components/chat/InputBar.tsx`
- `src/components/ControlCenter.tsx`
- `src/components/Sidebar.tsx`
- `scripts/test-session-runtime.mts`

不变量：

```text
事件 source
→ sessionLiveStats[source]
→ active sessionId
→ session.source
→ ControlCenter / InputBar
```

删除 Session 时，store 的 `removeSession()` 同步清理：

- `sessionLiveStats[source]`
- `sessionModes[source]`
- `sessionConfig[source]`
- `liveGeneratingSources` 中的 source

### BUG-03：宠物单击、双击和拖拽互相冲突

Commit：

```text
334ded2 fix(pet): 区分单击双击与拖拽手势
```

根因：

- pointerdown 立即进入 dragging。
- 没有单击入口。
- 双击依赖 WebView 合成的 `onDoubleClick`。
- pointerup 读取 React 闭包旧 position，可能持久化旧坐标。

修改：

- `src/components/PetCompanion.tsx`
- `src/components/PetCompanion.css`
- `src/components/petMotion.ts`
- `scripts/test-pet-motion.mts`

当前手势：

```text
位移 >= 6px              → drag
位移 < 6px 且时长 <=500ms → click
长按未移动                → none
两次 click 间隔 <=300ms   → double click
```

- 单击调用 `pet_action({ action: 'poke' })`。
- 双击清除位置并恢复漫游，不触发两次 poke。
- 拖拽最终位置使用 ref 持久化。

### BUG-04：SessionSettings 表单复用上一会话状态

Commit：

```text
bec5bdc fix(session): 切换会话时同步设置表单
```

根因：`useState(s?.field)` 只在组件首次挂载时读取 props；组件复用时不会随 `sessionId` 更新。

修改：

- `src/components/SessionSettings.tsx`
- `scripts/test-session-settings-lifecycle.mts`

实现：通过 `useEffect` 订阅 `sessionId` 和四个表单源字段，切换会话时同步名称、平台、工作目录和 Session Prompt。

### BUG-05：Agent 切换缺少交互锁和失败状态保护

Commit：

```text
7621fe9 fix(agent): 锁定切换交互并保持失败状态
```

根因：切换按钮可连续点击；切换事务与 UI 状态提交混在 Promise 链中，缺少显式成功/失败边界。

修改：

- `src/components/Settings.tsx`
- `src/components/agentSwitchTransaction.ts`
- `scripts/test-agent-switch-transaction.mts`

实现：

- 切换期间所有 Agent 按钮 disabled。
- 目标按钮显示“连接中…”，并设置 `aria-busy`。
- 当前 Agent 按钮不可重复点击。
- 只有 `switch_agent` resolve 后才提交 active Agent 和清理运行时状态。
- reject 时不改 active Agent、不清 Session，错误进入全局 runtime error UI。

当前成功后仍按既有产品行为执行：

- 清空本地 Session 集合。
- 清理 session config/mode/runtime/generating。
- 发出 `pylon:agent-switched`。

“切换 Agent 是否应保留本地 Session 资产”仍是产品决策，本批次没有擅自改变。

## 4. 自动验证

最终统一执行：

```text
node --experimental-strip-types scripts/test-session-settings-lifecycle.mts
结果：session settings lifecycle tests passed，exit code 0

node --experimental-strip-types scripts/test-agent-switch-transaction.mts
结果：agent switch transaction tests passed，exit code 0

node --experimental-strip-types scripts/test-replay-state.mts
结果：replayState 回归测试通过，exit code 0

node --experimental-strip-types scripts/test-session-runtime.mts
结果：sessionRuntime 回归测试通过，exit code 0

node --experimental-strip-types scripts/test-pet-motion.mts
结果：pet motion tests passed，exit code 0

npm run build
结果：通过，exit code 0
3322 modules transformed
主 bundle：850.40 kB，gzip 266.82 kB

git diff --check -- src scripts docs
结果：通过，exit code 0
```

既有 build warning：

1. `plugin-dialog` 同时被 Settings 动态导入和 InputBar 静态导入。
2. 主 chunk 超过 Vite 500 kB 提示线。

两项 warning 均未导致构建失败，也不是本批次引入的协议问题。

## 5. 真实运行时未验证项

本批次没有启动长期 Tauri/Peri 进程。以下必须在真实 WebView + Agent 环境验收，浏览器 mock 不可替代：

### 历史恢复

1. 有本地缓存、load 成功但零 replay 时，缓存仍存在。
2. replay event 缺少 meta 时，不启动 generation spinner。
3. 快速 A → B → A 时，迟到 load 不覆盖当前会话。

### Session runtime

1. A 生成中切到 B，B 不显示 A 的 token/cache/commands。
2. 切回 A，A 的统计恢复。
3. 删除正在生成的 A，生成态和宠物联动清理。
4. 后端关闭 Session 后是否仍发送迟到 source 事件。

### 宠物

1. 单击只调用一次 poke。
2. 双击不触发两次 poke。
3. 慢速拖拽超过 6px 后进入 dragging。
4. 拖拽后 reload，位置等于释放位置。
5. 双击后位置 key 被清除并继续漫游。

### SessionSettings

1. 不关闭 Dialog 的情况下从 A 切换到 B，四个表单字段全部变为 B。
2. 保存 B 不会写入 A 的旧值。

### Agent 切换

1. 连续快速点击不同 Agent，只发起一个 `switch_agent`。
2. 将目标 Agent 配置为不可连接，UI 保持旧 Agent 和旧 Sessions。
3. 成功切换后确认后端已经可用，而不是仅 command resolve。
4. 核实“切换成功后清空本地 Session”是否仍符合产品要求。

## 6. 剩余工作

### BUG-06：SessionSettings UI 信息层级弱

优先级：P3，UI 优化。

目标文件：

- `src/components/SessionSettings.tsx`
- `src/components/SessionSettings.css`
- 必要时通用 Dialog CSS

建议拆分：

1. 基本信息：名称、平台。
2. Agent 环境：工作目录、当前 Agent/连接状态。
3. Session Prompt。
4. 高级能力：Skills/Hooks 未接入状态折叠展示。
5. 删除操作移入独立危险区域，不与保存/取消同组。
6. 增加 dirty 状态和明确的丢弃策略。

约束：

- 不改变用户未要求的整体设计方向。
- 使用现有 CSS variables/uiScheme。
- DOM 删除时同步清理死 CSS。
- 不把 Skills/Hooks 伪装成已接入运行时。

## 7. 下一位 coder 的接管步骤

1. 执行：

```text
git status --short
git branch --show-current
git log -6 --oneline
git diff -- src scripts
git diff --cached
```

2. 保护本文件第 2 节列出的用户已有工作区内容。
3. 先运行上述 5 个回归脚本和 `npm run build`，确认基线。
4. 优先做真实 Tauri 验收；没有真实日志时不得把风险标记为已关闭。
5. 如继续开发，下一项为 BUG-06；按独立根因单独 commit。

## 8. 边界声明

- 修改后端：否。
- 修改依赖：否。
- 修改现有设计：否。
- 执行 commit：是，5 个源码 commit；本交接文档另行提交。
- 启动长期进程：否。
- 真实 Tauri/Agent 验收：未执行。
