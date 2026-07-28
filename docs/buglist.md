# Bug List

> 本文只依据当前工作区的前端源码与当前已接入的 Tauri command 进行分析。
>
> 约束：不使用已删除或过时的历史审计文档作为结论来源；不把“源码存在风险”冒充成已经通过运行时复现的事实。需要真实 Tauri/Agent 日志确认的项目，明确标注为“待运行时复现”。
>
> 当前工作区边界：`agents.yaml`、`src-tauri/src/acp.rs` 存在用户已有修改；`开发文档/前端交接清单.md` 为用户已有未跟踪文件。本轮只新增本文件及同目录的功能方向、交接规范文档，不修改上述文件。

## 复现操作范围

用户报告的“某些操作”包括：

- 切换预设
- 修改设置
- 开启新会话
- 删除会话
- 切换 Profile

这些操作会共同影响以下前端状态：

- 当前会话 ID：`App.tsx` 的 `activeSession`
- 当前 Profile：`store.ts` 的 `activeProfileId`
- 主题与布局：`store.ts` 的 `ThemeSettings`
- 消息缓存：`ChatView.tsx` 的 `messagesBySourceRef` 与 `pylon-msgs-*`
- 生成态与上下文统计：`liveGeneratingSources`、`liveTokensUsed`、`liveTokensMax`、`liveCacheReadTokens`

---

## BUG-01：切换会话/Profile/删除会话后，中控区上下文状态不是会话级真值

### 优先级

P1。会造成状态栏显示旧会话数据、数据归零、数据与当前历史会话不一致。

### 当前源码证据

1. 中控区直接读取全局 live 字段：

- `src/components/ControlCenter.tsx:17-18`
- `src/components/ControlCenter.tsx:60-61`
- `src/components/ControlCenter.tsx:73-76`
- `src/components/chat/StatusBar.tsx:105-107`

这些组件读取的是：

```ts
liveTokensUsed
liveTokensMax
liveCacheReadTokens
```

store 中这三个值只有一份全局值：

- `src/store.ts:83-85`
- `src/store.ts:240`

2. 事件处理只在“当前 source”匹配时更新统计：

- `src/components/chat/ChatView.tsx:248-255`

```ts
if (sessionRef.current === source) {
  useStore.getState().setLiveStats({
    liveTokensUsed: used,
    liveTokensMax: max,
    liveCacheReadTokens: ...,
  })
}
```

3. 切换会话时，`ChatView` 只清理本地消息、生成态和摘要，没有清理或切换 live stats：

- `src/components/chat/ChatView.tsx:58-84`

切换时执行：

```ts
setMessages([])
setGenerating(false)
setSummary(null)
```

但没有根据新会话恢复对应的 token/context/cache 状态，也没有把旧状态清零。

4. Profile 切换只清理当前会话选择：

- `src/App.tsx:33-37`
- `src/App.tsx:45-47`

`pylon:agent-switched` 和 Profile 归属检查最终只会 `setActiveSession(null)`，没有同步清理 live stats。

5. 删除会话时，侧栏只清理该会话的 `sessionConfig` 和消息缓存：

- `src/components/Sidebar.tsx:54-71`
- `src/components/SessionSettings.tsx:28-40`

没有清理该会话对应的 `sessionModes`、`liveGeneratingSources`、token/context 缓存。

### 根因判断

确认的结构性根因是：

> 中控区展示的数据是全局状态，但数据产生和消费实际上按 `source/session` 工作；切换操作没有一个统一的“当前会话运行时快照”恢复/清理入口。

因此以下情况都可能出现：

- 切到新会话后仍显示旧会话的 token 数和百分比。
- 切换到没有 usage update 的历史会话后显示默认值或空值。
- 删除正在生成的会话后，`liveGeneratingSources` 残留，宠物或输入栏仍认为有生成任务。
- 切 Profile 后当前界面没有 session，但中控区仍消费上一次全局统计。

### 修复方案

最小方案：

1. 新增按 `source` 保存的运行时统计：

```ts
sessionLiveStats: Record<string, {
  tokensUsed: number
  tokensMax: number
  cacheReadTokens: number
  commands: AvailableCommand[]
}>
```

2. `peri:update` 的 `usage_update` 与 `available_commands_update` 无论当前是否可见，都写入对应 `source` 的快照。
3. ControlCenter/StatusBar 根据当前 `sessionId -> source` 读取快照；无当前 session 时显示明确的空态，不复用上一会话数据。
4. `App` 在 Profile 切换、Agent 切换、删除当前会话时调用统一的运行时清理 action。
5. 删除会话时同步清理：

- `sessionLiveStats[source]`
- `sessionModes[source]`
- `sessionConfig[source]`
- `liveGeneratingSources` 中的 source
- 对应的 `generationStartRef`、消息内存缓存

6. 禁止 ControlCenter 内通过 `useStore.getState().sessions.find(...)` 直接读取当前 session。应通过响应式 selector 取得 session source，避免切换后组件没有重新订阅。

### 验证要求

必须在真实 Tauri 环境执行以下矩阵：

| 操作 | 预期 |
|---|---|
| A 生成中切到 B | A 的统计留在 A；B 不显示 A 的统计 |
| B 切回 A | A 的统计恢复 |
| 新建无历史会话 | 显示空态/默认协议值，不显示上一会话值 |
| 删除正在生成的会话 | 生成态、宠物生成态、输入栏停止态全部清理 |
| 切换 Profile | 当前 session 清空，状态栏不显示旧 Profile 数据 |
| 切换预设/修改主题 | 只改变视觉，不改变当前 session 的统计真值 |

---

## BUG-02：进入历史会话时，消息可能被空 replay 覆盖，只剩生成 spinner

### 优先级

P1。会造成历史会话内容不可见，并且可能把旧缓存删除。

### 当前源码证据

1. 进入历史会话时先读取本地缓存，再执行 `load_persisted_session`：

- `src/components/chat/ChatView.tsx:71-81`
- `src/components/chat/ChatView.tsx:106-125`

2. load 成功后无条件以 replay 缓冲区作为唯一结果：

```ts
const replayed = replayingSourcesRef.current[s.source] || []
const resolved = resolveLoadedMessages({ loadSucceeded: true, cached, replayed })
```

- `src/components/chat/ChatView.tsx:113-122`
- `src/components/chat/replayState.ts:15-17`

```ts
export function resolveLoadedMessages({ loadSucceeded, cached, replayed }) {
  return loadSucceeded ? replayed : cached
}
```

3. replay 为空时会删除本地缓存：

- `src/components/chat/ChatView.tsx:117-121`
- `src/components/chat/replayState.ts:19-21`

```ts
if (serialized) localStorage.setItem(...)
else localStorage.removeItem(...)
```

4. spinner 是否显示来自全局生成态：

- `src/components/chat/ChatView.tsx:82-84`
- `src/store.ts:88-93`
- `src/components/chat/GenerationFooter.tsx:43-62`

### 根因判断

当前源码存在两个可叠加的失败模式：

1. **空 replay 覆盖缓存**：`load_persisted_session` 只要 invoke 成功，即使前端没有收到任何 replay 消息，也会把 `cached` 替换成空数组并删除缓存。
2. **replay 标记缺失时误启动生成态**：`peri:user` 只认顶层 `payload.replay === true`，`peri:update` 只认 `update._meta.periReplay === true`。只要历史事件没有携带前端期待的精确标志，就会进入 live 消息路径；历史 user event 会调用 `startGenerating(source)`，但恢复流程未必存在与之配对的实时 `peri:done`。

对应证据：

- `src/components/chat/ChatView.tsx:169-180`
- `src/components/chat/ChatView.tsx:197-205`
- `src/components/chat/replayState.ts:11-17`

两个模式叠加时，界面就会表现为：

- 历史消息被清空
- `liveGeneratingSources` 中残留该 source
- GenerationFooter 只显示 spinner

这与用户报告的“只留下正在指示生成的 spinner”完全吻合。具体现场是否由事件缺少 replay meta、replay 时序不完整或后端返回空历史触发，需要真实 Tauri 事件日志确认；但前端当前逻辑已经构成确定性风险。

### 修复方案

1. **把 load 生命周期本身作为 replay 真值**：`load_persisted_session` 发起前标记该 source 正在 replay；处于该 load generation 期间的 user/update 事件统一进入 replay buffer，不能只依赖事件中的可选 meta。
2. `load_persisted_session` 增加独立的 `replaying/loading` 状态，不复用 live generating。
3. load response 成功不等于 replay 完成。需要一个明确的 replay 完成协议边界，前端不能把“invoke 成功”直接当成“replay 数据完整”。
4. 在 replay 为空时保留 `cached`，除非后端明确返回“该 session 历史确实为空”：

```ts
const resolved = replayed.length > 0
  ? mergeOrReplaceWithReplay(cached, replayed)
  : cached
```

5. 成功 load 不得立即删除本地缓存；只有拿到明确的完整历史结果后才覆盖缓存。
6. 进入历史会话时按 source 清理不属于当前恢复过程的生成态；历史 replay 不得触发 `startGenerating`。
7. `peri:user` 事件目前用 `replay` 字段区分，`peri:update` 用 `_meta.periReplay` 区分：

- `src/components/chat/ChatView.tsx:168-205`

应统一协议适配函数，避免两个 replay 标记格式不一致导致一半历史进入 replay buffer、另一半进入 live buffer。

8. load 失败的 fallback `createSession()` 需要明确提示“恢复失败，已创建新 session”，禁止静默让用户以为历史仍然存在。

### 验证要求

| 场景 | 预期 |
|---|---|
| 有本地缓存、后端 replay 非空 | 历史不重复，显示完整消息 |
| 有本地缓存、load 成功但 replay 暂时为空 | 保留缓存，不显示空页面 |
| 历史会话已结束 | 不显示 spinner |
| 历史会话之前异常中断 | 只在协议确认仍生成时显示 spinner |
| 快速 A/B/A 切换 | 旧 load 结果不能覆盖当前会话 |
| replay user/tool/assistant 混合事件 | 全部进入同一 replay buffer |

---

## BUG-03：宠物没有单击交互，双击恢复漫游和拖拽状态链不稳定

### 优先级

P2。

### 当前源码证据

1. 宠物 DOM 只有双击处理，没有单击行为：

- `src/components/PetCompanion.tsx:283-295`

```tsx
<section ... onPointerDown ... onPointerMove ... onPointerUp>
  <div className="pet-creature-hitbox" onDoubleClick={resumeWander}>
```

不存在 `onClick`，因此“点击宠物无反应”是当前代码的预期结果，不是随机故障。

2. 视觉动画只定义了漫游位置 transition 和 CSS animation：

- `src/components/PetCompanion.css:18-30`

拖拽时明确关闭 transition：

```css
.pet-companion.dragging { cursor:grabbing; transition:none; }
```

因此拖拽过程不会有位置过渡动画；只有自主漫游的 `left/top` 变化才会有 steps transition。

3. 拖拽结束时使用闭包中的旧 `position` 保存位置：

- `src/components/PetCompanion.tsx:257-269`

`onPointerMove` 中通过 `setPosition()` 更新 state，`onPointerUp` 随后读取的 `position` 可能仍是 pointerdown 前的值，导致视觉上拖到了新位置，但 reload 后恢复旧位置。

4. 双击恢复漫游与拖拽共用 Pointer Events：

- `src/components/PetCompanion.tsx:246-275`

pointerdown 会立即：

- 关闭漫游
- 设置 dragging
- 调用 `setPointerCapture`

双击事件是否稳定触发，取决于 WebView 对 pointer capture 与 click/dblclick 合成事件的处理，当前没有专门的点击/双击判定和验证。

5. 宠物命令只用于 restore/get_pet，没有点击 action：

- `src/components/PetCompanion.tsx:147-159`
- `src-tauri/src/lib.rs:523-545`（仅作为当前已接入契约核对）

### 修复方案

1. 明确交互语义：

- 单击：调用 `pet_action({ action: 'poke' })`，更新宠物状态/气泡/动画。
- 双击：恢复自主漫游，不调用 poke。
- 拖拽：固定位置，显示 dragging 视觉反馈。

2. 使用 Pointer Events 自己判定 click/double click，避免 `onPointerDown` 同时把所有点击都当成拖拽：

- 记录 pointerdown 坐标和时间。
- 位移小于阈值且时间短，视为 click。
- 连续两次 click 在 double-click 窗口内，视为 double click。
- 位移超过阈值后才进入 dragging。

3. `onPointerUp` 不读取闭包旧 state。用 `positionRef` 同步当前坐标，或在 `setPosition(prev => { ...; positionRef.current = next; return next })` 中同步保存。
4. 拖拽 CSS 增加明确反馈：

- `transform` 微缩放或像素阴影变化。
- `cursor: grabbing`。
- 可选的短暂 `filter/drop-shadow`。
- 不恢复自主漫游的 transition 到拖拽态。

5. 双击恢复漫游后清理固定位置，同时把 `perched`、`walking`、`behavior` 收敛到明确状态。

### 验证要求

- 单击一次：有 poke 命令、宠物状态或气泡变化。
- 双击：清除固定坐标并恢复漫游。
- 慢速拖拽：有 dragging class 和视觉反馈。
- 拖拽后 reload：位置与释放位置一致。
- 拖拽不触发 poke；双击不产生两次 poke。

---

## BUG-04：会话设置表单状态不跟随切换的 session 更新

### 优先级

P2。

### 当前源码证据

- `src/components/SessionSettings.tsx:11-19`

组件只在首次挂载时使用 props 初始化表单：

```ts
const [name, setName] = useState(s?.name || '')
const [platform, setPlatform] = useState(s?.platform || 'local')
const [workdir, setWorkdir] = useState(s?.workdir || '')
const [sessionPrompt, setSessionPrompt] = useState(s?.sessionPrompt || '')
```

没有针对 `sessionId` 或 `s` 的 `useEffect` 重置表单。

### 影响

如果 Dialog 实例未卸载、或打开不同会话时组件复用，表单可能保留上一个会话的名称、工作目录和 Prompt。保存后会把错误数据写入新会话。

### 修复方案

1. 将表单状态初始化和当前 session 绑定：

```ts
useEffect(() => {
  setName(s?.name || '')
  setPlatform(s?.platform || 'local')
  setWorkdir(s?.workdir || '')
  setSessionPrompt(s?.sessionPrompt || '')
}, [sessionId, s?.name, s?.platform, s?.workdir, s?.sessionPrompt])
```

2. 或在 `App.tsx` 使用 `key={sessionSettingsId}` 强制每个会话创建独立表单实例。
3. 保存时对名称、工作目录、Prompt 做 trim 策略，明确是否保留用户有意输入的空格。

---

## BUG-05：切换 Agent 的前端状态更新缺少失败回滚与交互锁

### 优先级

P2，属于当前代码审查发现，需运行时复现确认用户是否遇到。

### 当前源码证据

- `src/components/Settings.tsx:414-434`

切换按钮直接调用 `invoke('switch_agent')`，没有 loading/disabled 状态，也没有防止连续点击。

成功后直接执行：

```ts
useStore.setState({
  activeAgent: a.id,
  sessionConfig: {},
  liveGenerating: null,
  liveGeneratingSources: [],
})
useStore.getState().replaceSessions([])
window.dispatchEvent(new CustomEvent('pylon:agent-switched'))
```

这会清空前端 session 集合；但没有处理 ACP 替换成功后历史 session 的重新加载流程，也没有显示连接状态。

### 修复方案

1. 切换过程中按钮 disabled，显示“连接中”。
2. 先等待 `switch_agent` 成功，再更新 activeAgent；失败不改变前端 activeAgent 和 session 集合。
3. 成功后调用 `agent_status` 或等待 `peri:agent-status`，确认 connected 后再清理/重建 session 状态。
4. 明确“切换 Agent 是否保留本地会话列表”。如果保留，不能使用 `replaceSessions([])`；应按 Agent 维度隔离运行时 source，而不是删除用户本地历史。
5. 同时监听 `peri:agent-status`，呈现 connected/reconnecting/error。

---

## BUG-06：会话设置 UI 信息层级弱，状态不可用提示占据主流程

### 优先级

P3，属于 UI 优化问题；不是功能链路 Bug。

### 当前源码证据

- `src/components/SessionSettings.tsx:46-88`
- `src/components/SessionSettings.css:1-16`
- `src/index.css:89-90`

当前结构是一个普通表单 + 一个底部危险操作按钮：

- 名称、平台、工作目录、Prompt 全部同一层级。
- `Skills / Hooks` 使用虚线框放在主表单中，且内容是“未接入运行时”。
- 删除按钮和保存/取消按钮位于同一行，仅通过 `margin-left:auto` 区分。
- Dialog 只设置通用 `min-width:400px`，SessionSettings 自身只设置 `max-width:520px`，缺少专门的 header、section、footer 视觉结构。

### 优化方案

1. 设置页分区：

- 基本信息：名称、平台
- Agent 运行环境：工作目录、当前 Agent、连接状态
- Prompt：当前会话 Prompt 与预设选择
- 高级能力：MCP/Skills/Hooks；未接入时折叠并标明状态

2. 将删除会话移动到独立的“危险区域”，使用分隔线、警示文案和二次确认，不与保存按钮同组。
3. Dialog 使用更明确的宽度、内边距、标题副标题、sticky footer。
4. textarea 使用更清楚的提示和字符/行数反馈。
5. 暗色/浅色统一使用项目 CSS token，不在 SessionSettings 中额外硬编码颜色。
6. 对表单增加 dirty 状态：未修改时关闭不提示；有修改时取消关闭应提示或明确丢弃修改。

---

## 当前不应直接判定为 Bug 的项目

以下问题需要真实运行时证据才能关闭：

- 某一特定预设导致状态栏完全不渲染：当前源码显示预设会更新 `ccStyle`、`ccLayout` 等，但尚未拿到 DOM/console 证据。
- `load_persisted_session` 是否实际返回空 replay：需要 Tauri event 日志和 invoke response。
- 点击宠物无反应是否同时伴随 WebView pointer event 被其他层遮挡：当前 DOM 已确认没有单击 handler，但遮挡仍需 DOM hit-test 验证。
- 删除会话后后端 ACP 是否仍发送旧 source 事件：需要 `peri:*` event 日志。

---

## 建议修复顺序

1. BUG-02：先阻止历史消息被空 replay 覆盖，并隔离恢复态与生成态。
2. BUG-01：建立 per-session runtime snapshot，修复中控区数据串会话。
3. BUG-03：补齐宠物 click/double-click/drag 状态机。
4. BUG-04：修复 SessionSettings 表单生命周期。
5. BUG-05：Agent 切换交互锁与连接状态。
6. BUG-06：会话设置 UI 重排。

每个 Bug 应独立验证；不要把“状态清理”“消息恢复”“UI 美化”塞进同一个 commit。
