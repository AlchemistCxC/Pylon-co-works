# Pylon V12 — UI 重构 + 中控自定义

> 给 coder。6 个模块。读完再写。

---

## 一、标题栏 → Tab 栏

### 1.1 新结构

```
┌ ☰ [Peri] [Prism]                     [─] [⛶] [✕] ┐
│                                                      │
│  ChatView（消息区，无 header）                         │
│                                                      │
│  ── ControlCenter ─────────────────────────────────  │
└──────────────────────────────────────────────────────┘
```

删 `titlebar-text "Pylon"`。删 ChatView 的 `chat-header`（整个 div + chat-title span）。

### 1.2 App.tsx

```tsx
<div className="titlebar" data-tauri-drag-region>
  <button className="titlebar-toggle" onClick={...}>☰</button>
  <div className="titlebar-tabs">
    <button className={`tab ${activeTab==='peri'?'active':''}`} onClick={...}>Peri</button>
    <button className={`tab ${activeTab==='prism'?'active':''}`} onClick={...}>Prism</button>
  </div>
  <div className="titlebar-spacer" />  {/* flex:1 自然撑开 */}
  <div className="titlebar-controls">...</div>
</div>
```

### 1.3 CSS

```css
.titlebar {
  height: 32px;
  display: flex;
  align-items: center;
  padding: 0 8px;
  background: var(--titlebar-bg, rgba(0,0,0,0.02));
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
  gap: 4px;
}

.titlebar-toggle {
  -webkit-app-region: no-drag;
  background: none; border: none;
  color: var(--text-dim); cursor: pointer;
  font-size: 15px; padding: 0 6px;
  flex-shrink: 0;
}

.titlebar-tabs {
  display: flex; gap: 2px;
  -webkit-app-region: no-drag;
  flex-shrink: 0;
}

.titlebar-tabs .tab {
  padding: 3px 14px; border-radius: 4px;
  border: none; background: transparent;
  color: var(--text-dim); cursor: pointer;
  font-size: 12px; font-family: var(--font);
  -webkit-app-region: no-drag;
}

.titlebar-tabs .tab.active {
  background: var(--bg-panel);
  color: var(--text);
}

.titlebar-spacer {
  flex: 1;
  -webkit-app-region: drag;
}

.titlebar-controls {
  display: flex; gap: 2px;
  -webkit-app-region: no-drag;
  flex-shrink: 0;
}
```

### 1.4 折叠按钮不重叠

☰ 在最左边（`flex-shrink:0`），tab 紧随其后（`flex-shrink:0`）。侧栏折叠时 ☰ 仍可见（它在 titlebar 内，不跟着侧栏消失）。

---

## 二、ChatView 无 header

### 2.1 删 chat-header

```typescript
// ChatView.tsx — L223-233 整块删掉
// 删:
// <div className="chat-header">
//   <span className="chat-title">...</span>
// </div>
```

### 2.2 autoName 移到左栏

`addSession` 时存 `autoName`。侧栏 `session-name` 显示 `s.autoName`（有则用）或 `s.name`（重命名后）。不再在 ChatView 内显示。

### 2.3 消息区贴顶

CSS 确认 `.term` 的 `padding-top` 不要过大——保持 `16px 24px` 即可。

---

## 三、当前 Agent 标签

Peri tab 根据 `activeAgent` 动态显示：

```tsx
const activeAgent = useStore(s => s.activeAgent) || 'peri'
const agentLabel = activeAgent.charAt(0).toUpperCase() + activeAgent.slice(1)

<button className={`tab ${activeTab==='peri'?'active':''}`} onClick={...}>
  {agentLabel}
</button>
```

`switch_agent` 后 tab 自动更新标签文字。

---

## 四、中控区拖拽自定义

### 4.1 Settings → 中控区 → 控件排序

`@dnd-kit/sortable` 实现控件列表拖拽排序：

```tsx
// Settings.tsx, Tabs.Content value="cc"
<DndContext onDragEnd={handleDragEnd}>
  <SortableContext items={layout} strategy={verticalListSortingStrategy}>
    {layout.map(id => (
      <SortableWidget key={id} id={id} label={LABELS[id]} />
    ))}
  </SortableContext>
</DndContext>
```

每个控件行：`☰ draghandle | [名称] | ✓ 显隐 | [宽度]`

store 加：
```typescript
ccLayout: string[]   // ['input', 'context', 'model', 'mode', 'attach', 'commands']
ccHidden: string[]   // 隐藏的控件 ID
ccSizes: Record<string, number>   // 每控件宽度
```

ControlCenter 渲染时按 `ccLayout` 顺序，跳过 `ccHidden` 中的控件。

### 4.2 中控区高度

Settings → 中控区 → 高度 slider（80-400px）。已有 `ccHeight` 字段，确认生效。

### 4.3 中控区背景色

已有 `ccBg` 字段。Settings → 中控区 → 背景色 Swatch。设为 `transparent` → 融入 ChatView（模拟终端）。

### 4.4 动态分配

ChatView CSS 已有 `flex:1`，ControlCenter CSS 已有 `flex-shrink:0`。改 `--cc-height` → ChatView 自动适应。

---

## 五、BUGFIX：上下文数据不更新

**根因**：`event.payload.source !== sessionRef.current` —— source ≠ id，永远不匹配。

**修复**：`sessionRef` 存储 session 的 source 而非 id：

```typescript
// ChatView.tsx
const sessionRef = useRef<string | null>(null)

useEffect(() => {
  const s = useStore.getState().sessions.find(s => s.id === sessionId)
  sessionRef.current = s?.source || null
}, [sessionId])
```

然后 `event.payload.source !== sessionRef.current` 就能正确匹配。所有 `peri:update` 事件（含 usage_update）现在能通过 filter。

---

## 六、字体

不引入外部字库。微调现有字体：

```css
/* index.css */
--mono: 'Cascadia Code', 'Consolas', monospace;

/* ChatView.css .term */
.term {
  font-family: var(--chat-font, var(--mono));
  font-weight: 350;
  letter-spacing: -0.2px;
  font-feature-settings: "calt" off;
  -webkit-font-smoothing: auto;
  text-rendering: optimizeLegibility;
  font-kerning: none;
}
```

- `font-weight: 350` — 比终端略轻
- `letter-spacing: -0.2px` — 微收紧等宽感
- `font-feature-settings: "calt" off` — 关连字
- `-webkit-font-smoothing: auto` — 保留 ClearType 平滑中文

---

## 给 coder

1. 标题栏 + ChatView 无 header → commit 1
2. 中控拖拽 + 高度/背景 → commit 2
3. BUGFIX source filter + 字体 → commit 3
4. Prism 占位 tab 保留
5. 分批，不 build
