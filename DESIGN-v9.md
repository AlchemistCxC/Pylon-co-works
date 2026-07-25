# Pylon V9 设计书 — 三次修复 + 架构微调

> 给 coder。3 个必须修 + 1 个架构建议。

---

## 一、B1 — chat header 永不显示 raw ID

**根因**：ChatView L229 `find(s => s.source === sessionId)` 但 `sessionId` 是 session 的 `id`（如 `"slxv2f"`），`source` 是 `"local:session-xxx"`。永远不匹配。

**修复**：

```typescript
// ChatView.tsx L227-231 — 改 source 为 id
const s = useStore.getState().sessions.find(s => s.id === sessionId)
if (!s) return '新会话'  // ← 永远不显示 raw ID
return s.autoName || (s.name.startsWith('session-') ? `新会话 · ${formatTime(s.createdAt)}` : s.name)
```

fallback 从 `sessionId` 改为 `'新会话'`——任何情况下都不暴露 raw ID。

---

## 二、ChatView/ControlCenter 分块

**问题**：ControlCenter 设置（ccStyle/ccHeight/inputMode）变化 → theme 对象变化 → App re-render → ChatView re-render → 消息列表不必要地刷新。

**修复**：`React.memo` 包裹 ChatView，只在 `sessionId` 变化时重渲染：

```typescript
// ChatView.tsx
export default React.memo(function ChatView({ sessionId }: Props) {
  // ... 内容不变
})
```

ControlCenter 单独订阅自己的 store 字段（已经在做），设置变化只重渲染 ControlCenter 自身。

中控区高度变化时 ChatView 自动适应——通过 CSS flex 布局，不需要 React 重渲染：

```css
.main-body { flex:1; display:flex; flex-direction:column; min-height:0; overflow:hidden; }
.control-center { flex-shrink:0; }
.chat-view { flex:1; }  /* 自动填满剩余空间 */
```

---

## 三、B3 — 侧栏折叠按钮（第三次，最后一次）

**根因**：`.layout { overflow: hidden; position: relative }` + toggle `position:absolute; left:-16px` → 按钮在 clip 边界外被裁掉。

**修复**：按钮移出 `.layout`，放在 `.app` 内、`.layout` 外，用 `position:fixed`：

```tsx
// App.tsx — 移到 layout 外面
<div className="app" style={cssVars}>
  {/* ... titlebar ... */}
  <button className="sidebar-toggle-float"
    style={{ position:'fixed', left: sidebarCollapsed ? 0 : 'var(--sidebar-width,250px)', top:'50%', transform:'translateY(-50%)', zIndex:100 }}
    onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
    {sidebarCollapsed ? '▸' : '▾'}
  </button>
  <div className="layout">
    <Sidebar ... />
    <div className="main">...</div>
  </div>
</div>
```

用 `position:fixed` + 动态 `left`——侧栏打开时按钮在 sidebar 右边，收起时在最左边。浮在所有内容上方，z-index 确保可见。

CSS 清理：删 `.sidebar-toggle-float` 里的 `position:absolute; left:-16px`，保留颜色/大小/hover。

---

## 四、UI 库引入（延后）

Radix UI（`@radix-ui/react-dialog` + `@radix-ui/react-dropdown-menu`）替换手写弹窗/下拉，无障碍自动到位。不着急。

---

## 给 coder

1. B1 一行改 `source` → `id` + fallback `'新会话'`
2. ChatView `React.memo` 一行包
3. B3 用 `position:fixed` + 动态 `left`，按钮放 `.layout` 外
4. B4 临时：`ChatView.tsx` L166 前加 `console.log('[usage_update]', upd.value, upd.size)`，验证数据链路
5. B5 StatusBar 无 session 时隐藏 ECG/tokens/mode，只保留占位或空
6. commit 分批，不 build
