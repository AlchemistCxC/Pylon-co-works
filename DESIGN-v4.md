# Prism Desktop V4 设计书 — Agent UI + 容错 + 输入栏样式 + 消息交互

> 给 coder。工作流程同 V2/V3：写完 commit（不 build）→ 我审计 → REVIEW-v4.md → 修 → build。

---

## 一、总体范围

| 优先级 | 模块 | 内容 |
|:--|:--|:--|
| P0 | Agent UI 接线 | StatusBar 显示 agent 名 + 切换下拉，前端调 `list_agents`/`switch_agent` |
| P0 | 容错 | React ErrorBoundary + ACP 断线检测 + 发送失败 toast + 启动加载状态 |
| P1 | 输入栏 CLI 双横线 | CSS 伪元素 + Settings 可配（颜色/宽度/模式切换） |
| P2 | 消息交互 | 复制按钮、重发、滚动到底、会话重命名、时间戳 |

---

## 二、P0-1：Agent 选择（Settings 面板）

### 目标

Agent 不是运行时随手切换的东西——换 agent 意味着换 ACP 连接，当前所有会话失效。所以 agent 选择放在 Settings 中，选后标记"需重启生效"。StatusBar 只显示当前 agent 名（只读）。

### Settings 新增 "Agent" 分类

`Settings.tsx` NAV 加一项：

```typescript
{ key: 'agent', label: 'Agent' }
```

内容：

```tsx
{sec === 'agent' && <>
  <h3>Agent</h3>
  <Group title="当前 Agent">
    <div style={{ padding: '8px 0', fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--accent)' }}>
      {activeAgent}
    </div>
  </Group>
  <Group title="切换 Agent（需重启）">
    {agents.map(a => (
      <Row key={a.id} label={a.name}>
        <button className={`ps-btn sm ${a.id === activeAgent ? 'primary' : ''}`}
          onClick={() => {
            invoke('switch_agent', { name: a.id }).then(() => {
              useStore.getState().setActiveAgent(a.id)
            })
          }}>
          {a.id === activeAgent ? '当前' : '切换'}
        </button>
      </Row>
    ))}
  </Group>
  <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-dim)' }}>
    切换 Agent 后需重启 Prism Desktop 生效。
  </div>
</>}
```

### StatusBar 只读显示

```tsx
// StatusBar.tsx — 替换 model-dropdown 为静态 agent 名
<span className="pill-mono" style={{ color: 'var(--accent)' }}>
  {activeAgent || 'peri'}
</span>
```

agent 名放在 token 计数后面、Prism 标签前面。

### App.tsx 启动加载

```tsx
useEffect(() => {
  invoke('list_agents').then((list: any) => {
    useStore.getState().setAgents(list)
  }).catch(() => {})
}, [])
```

### store.ts

```typescript
agents: { id: string; name: string }[]
activeAgent: string
setAgents: (a: { id: string; name: string }[]) => void
setActiveAgent: (id: string) => void
```

### 参考

- `lib.rs` L146-161 — list_agents / switch_agent
- `Settings.tsx` L6-16 — NAV 定义
- `StatusBar.tsx` L107-108 — pill-mono 用法

---

## 三、P0-2：容错

### 3.1 React ErrorBoundary

新增 `src/components/ErrorBoundary.tsx`：

```tsx
import { Component, ErrorInfo, ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Prism Desktop crashed:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center',
          height:'100%', flexDirection:'column', gap:16, color:'var(--text-dim)' }}>
          <div style={{ fontSize:48 }}>!</div>
          <div style={{ fontSize:16, fontWeight:600 }}>Prism Desktop 遇到了一个错误</div>
          <div style={{ fontSize:13, maxWidth:400, textAlign:'center', fontFamily:'var(--mono)' }}>
            {this.state.error.message}
          </div>
          <button onClick={() => this.setState({ error: null })}
            style={{ padding:'8px 20px', border:'1px solid var(--border)', borderRadius:6,
              background:'var(--bg-panel)', color:'var(--text)', cursor:'pointer' }}>
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
```

`App.tsx` 包裹：

```tsx
<ErrorBoundary>
  <div className="app" style={cssVars}>
    {/* ... */}
  </div>
</ErrorBoundary>
```

### 3.2 启动加载状态

`run()` 中 ACP 连接需要 1-3 秒。当前白屏。加一个初始 loading flag：

```tsx
// App.tsx
const [connected, setConnected] = useState(false)

// Tauri setup 完成后 emit 事件
// 或者用 store 的 liveConnected 字段
```

最简单方案：store 加 `liveConnected: boolean`，`run()` 中 `AcpClient::connect().await` 后 `emit` 通知前端：

```rust
// lib.rs run()
let acp = Arc::new(AcpClient::connect(&default_agent).await.expect("..."));
// 通知前端
```

前端：

```tsx
// ChatView.tsx — 启动时的 loading 画面
if (!useStore(s => s.liveConnected)) {
  return <div className="chat-empty">
    <div className="empty-icon">⟳</div>
    <div className="empty-sub">正在连接 Agent...</div>
  </div>
}
```

### 3.3 发送失败 toast

当前 `InputBar.send()` 的 catch 只有 `console.error`。改为：

```tsx
const [error, setError] = useState('')

// send() 中:
catch (e) {
  setError(String(e))
  setTimeout(() => setError(''), 4000)
}

// JSX:
{error && <div className="input-error">{error}</div>}
```

CSS：

```css
.input-error {
  position: absolute; bottom: 100%; left: 0; right: 0;
  padding: 6px 12px; background: rgba(190,40,40,0.1);
  color: var(--danger); font-size: 13px; border-radius: 6px;
  margin-bottom: 8px;
}
```

### 3.4 ACP 断线检测（最低实现）

`acp.rs` 的 reader 线程退出时（stdout pipe 关闭 = peri.exe 挂了），emit 一个 events。lib.rs 中 reader 线程结束后通知前端：

```rust
// 不要求完整重连机制，至少让用户知道断了
// 可以在 reader 线程的 for 循环退出后 log + emit
```

最低：reader 线程退出时打 log，用户下次发消息时 `send_message` 的 `?` 会传播错误 = `input-error` toast。

### 参考

- `App.tsx` L83-132 — 主布局
- `src-tauri/src/lib.rs` L207-241 — run()
- `InputBar.tsx` L66-80 — send()
- `ChatView.tsx` L189-194 — empty state

---

## 四、P1：输入栏 CLI 双横线

### 目标

输入栏可在 Settings 中切换为 CLI 风格：无边框、无背景、上下各一条横线，横线颜色/宽度可配。

### CSS

```css
/* InputBar.css — 新增 */
.input-bar.cli-mode {
  border: none;
  background: transparent;
  padding-top: 0;
}
.input-bar.cli-mode .input-row {
  position: relative;
  padding: 14px 0;
}
.input-bar.cli-mode .input-row::before,
.input-bar.cli-mode .input-row::after {
  content: '';
  position: absolute;
  left: 0; right: 0;
  height: var(--cli-line-width, 2px);
  background: var(--cli-line-color, var(--accent));
}
.input-bar.cli-mode .input-row::before { top: 0; opacity: 0.5; }
.input-bar.cli-mode .input-row::after { bottom: 0; opacity: 0.8; }
.input-bar.cli-mode .input-textarea {
  background: transparent;
  border: none;
  padding: 10px 0;
  border-radius: 0;
  color: var(--cli-text-color, var(--text));
  font-family: var(--mono);
}
.input-bar.cli-mode .input-textarea:focus {
  outline: none;
  border: none;
  box-shadow: none;
}
.input-bar.cli-mode .input-btn {
  background: transparent;
  border-color: var(--cli-line-color, var(--accent));
  border-radius: 4px;
}
```

### store.ts 新增

```typescript
// ThemeSettings
inputMode: string            // 'default' | 'cli', 默认 'default'
cliLineWidth: number         // 双横线宽度，默认 2
cliLineColor: string         // 双横线颜色，默认 ''（空=跟随 --accent）
cliTextColor: string         // CLI 模式文字颜色，默认 ''
```

### Settings UI

Settings → 输入栏 section → 新 Group "CLI 风格"：

```
Row label="模式"     Sel value={t.inputMode} options=['default','cli']
Row label="横线宽度" Num value={t.cliLineWidth} min={1} max={6}
Row label="横线颜色" Swatch value={t.cliLineColor}
Row label="文字颜色" Swatch value={t.cliTextColor}
```

### InputBar.tsx 改动

```tsx
const inputMode = useStore(s => s.inputMode)
// ...
<div className={`input-bar ${inputMode === 'cli' ? 'cli-mode' : ''}`}>
```

### App.tsx cssVars 映射

```typescript
'--cli-line-width': `${theme.cliLineWidth}px`,
'--cli-line-color': theme.cliLineColor || undefined,
'--cli-text-color': theme.cliTextColor || undefined,
```

### 参考

- `InputBar.css` L1-28 — 当前样式
- `Settings.tsx` L151-165 — input section
- `App.tsx` L58-65 — input CSS var 映射

---

## 五、P2：消息交互

### 5.1 消息复制

`AssistantContent` 组件加复制按钮，hover 时显示：

```tsx
function AssistantContent({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="term-assistant" onMouseEnter={...} onMouseLeave={...}>
      <ReactMarkdown ...>{text}</ReactMarkdown>
      <button className="copy-btn" onClick={() => {
        navigator.clipboard.writeText(text)
        setCopied(true); setTimeout(() => setCopied(false), 2000)
      }}>{copied ? '✓' : '⎘'}</button>
    </div>
  )
}
```

CSS：

```css
.term-assistant { position: relative; }
.term-assistant .copy-btn {
  position: absolute; top: 0; right: 0;
  opacity: 0; background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 4px; padding: 2px 8px; font-size: 12px; cursor: pointer;
  color: var(--text-dim);
}
.term-assistant:hover .copy-btn { opacity: 1; }
```

### 5.2 滚动到底

ChatView 已有 `bottomRef` + `scrollIntoView`（L173）。加一个浮动按钮在长消息溢出时显示：

```tsx
const [showScrollBtn, setShowScrollBtn] = useState(false)
// onScroll 判断是否在底部
// ...
{showScrollBtn && (
  <button className="scroll-bottom-btn" onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}>
    ↓
  </button>
)}
```

### 5.3 会话重命名

Sidebar session-item 双击 → inline 编辑：

```tsx
const [renaming, setRenaming] = useState<string | null>(null)
// onDoubleClick → setRenaming(s.id)
// Enter → 更新 store.sessions 中对应 name + localStorage
```

### 5.4 会话时间戳

`Session` 接口加 `createdAt` 和 `lastActiveAt`：

```typescript
interface Session {
  // ... existing
  createdAt: number
  lastActiveAt: number
}
```

`Sidebar.tsx` 的 `session-meta` 显示相对时间：

```tsx
<div className="session-meta">
  {formatRelative(s.lastActiveAt || s.createdAt)}
</div>
```

### 5.5 重发消息

InputBar 加 Ctrl+↑ 或按钮：

```tsx
const [lastMessage, setLastMessage] = useState('')

// send() 成功后
setLastMessage(text)

// Ctrl+↑ 或点击重发按钮
const retry = () => {
  if (lastMessage) setValue(lastMessage)
}
```

### 参考

- `ChatView.tsx` L61-65 — bottomRef, messages
- `Sidebar.tsx` L74-83 — session-item 渲染
- `InputBar.tsx` L66-80 — send()

---

## 六、给 coder 的话

1. **P0-2 容错优先**——error boundary 和 loading state 改动小但体验提升大。先做这两个，再做 agent UI。
2. Agent 切换目前只能做"显示 + 提示需重启"，hot-swap 需要重构 ACP 连接管理，后续单独做。
3. CLI 双横线是纯 CSS + Settings，不碰 TSX 逻辑，可以独立做。
4. P2 消息交互四项各自独立，分批 commit。
5. 每完成一个 P 就 commit。不 build。
