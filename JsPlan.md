# JsPlan — Pylon 前端待修（核验版）

## 真实残留

### B1 — ChatView header 仍用 getState()
`ChatView.tsx` L227 `useStore.getState().sessions.find(...)` → 应改为 `useStore(s => ...)`。

### B2 — /export 查找字段错误
`InputBar.tsx` L70 `s.source === sessionId` → `sessionId` 是 id 不是 source。

### B3 — Settings 多处 getState()
`Settings.tsx` L81 ccHidden、L318 activeAgent、L322 agents.map → 不响应式。

### B4 — ErrorBoundary "Prism Desktop"
`ErrorBoundary.tsx` L12/L21 → 应改为 "Pylon"。

### B5 — profileEditor includes() 引用比较 → 可能重复创建 profile

### B6 — ChatView toolCallId 可能 undefined → ID 冲突

### B7 — peri:error 对象 payload → "[object Object]"

## 清理

### C1 — MessageBubble.tsx 62 行死代码
### C2 — unused imports (ChatView useCallback/invoke, InputBar readTextFile)
### C3 — CSS 孤儿类 15 处
### C4 — React.memo 缺失 (InputBar/StatusBar/ControlCenter)
### C5 — App.tsx 全 store 订阅
