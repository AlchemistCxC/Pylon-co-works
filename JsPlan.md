# JsPlan — Pylon 前端待修

> 给前端开发者。基于 2026-07-26 全面审计。

---

## P1 — Bug 修复

### 1. chat header 永不显示 raw ID
改用 hook 订阅 `useStore(s => s.sessions.find(...))` 替代 `getState()` IIFE。

### 2. 侧栏折叠按钮移到 ChatView 左上角
当前在 titlebar `☰`，用户找不到。移到中间栏左上角常驻。

### 3. InputBar CLI 切换不响应
`useStore.getState().inputMode` 在 render 中不触发重渲染。改为 `useStore(s => s.inputMode)`。

### 4. Settings/Agent getState() → hook
`Settings.tsx` L318-330 多处 `getState()`，不响应式更新。

### 5. ProfileEditor includes() 引用比较
`includes(profile)` 可能因 zustand 不可变更新返回新引用 → 重复创建 profile。

### 6. InputBar `/export` 查找字段错误
`s.source === sessionId` → sessionId 是 id 不是 source，永远不匹配。

### 7. ChatView toolCallId 可能 undefined
`id: 'tool-' + upd.toolCallId` → undefined 时所有 tool 共用同一 ID。

### 8. peri:error 对象 payload
`'⚠️ ' + event.payload` → 对象时显示 `[object Object]`。

---

## P2 — 性能

### 9. App.tsx 全 store 订阅
`useStore()` 无 selector → 任何 liveTokensUsed 变化都重渲染根组件。

### 10. StatusBar 33fps
`setInterval(tick, 30ms)` → 每秒 ~33 次重渲染。降到 50ms（20fps）。

### 11. Sidebar PLATFORM_LABELS + Map 每帧重建
提取到模块级常量，用 `useMemo` 包裹 groups 计算。

### 12. ChatView scrollIntoView 无节流
每次 messages 变化都触发，流式输出时极高频。

---

## P3 — 清理

### 13. MessageBubble.tsx + CSS 死代码（62行）
从未被引用，删。

### 14. formatTime 重复定义
Sidebar.tsx 和 ChatView.tsx 各一份。提取到 `utils.ts`。

### 15. CSS 孤儿类 15 处
`.ekg-pulse`、`.prism-tag`、`.term-h2/h3/li/p` 等——对应的 HTML 已删除，CSS 残留。

### 16. unused imports
`ChatView.tsx` `useCallback`、`invoke`；`InputBar.tsx` `readTextFile`；等。

### 17. "Prism Desktop" → "Pylon"
`ChatView.tsx` L219 empty state + `ErrorBoundary.tsx` L21 文本。

### 18. React.memo
只 ChatView 用了。InputBar、StatusBar、ControlCenter、Sidebar 均未 memo。
