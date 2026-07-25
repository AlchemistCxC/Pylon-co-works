# JsPlan — Pylon 前端待修

## 后端新增接口（接上就行）

### new_session 返回值变了
**之前**：返回 `string`（sessionId）
**现在**：返回 `object`
```json
{
  "sessionId": "sess_xxx",
  "modes": ["chat", "agent"],
  "configOptions": [{"key": "model", "value": "deepseek-v4-flash", "category": "model_config"}]
}
```
`ChatView.tsx` `handleSend` / `Sidebar.tsx` `handleNewSession` 的 `invoke('new_session')` 解构要改。

### 新命令 set_config_option
```typescript
invoke('set_config_option', { source, key: 'model', value: 'gpt-4o' })
// 返回 configOptionUpdate 对象（含 modes/configOptions）
```
给 `ModelWidget.tsx` 用。传当前 session 的 source、key/value，即可切 model。

### set_mode 不变
`invoke('set_mode', { source, mode: 'agent' | 'chat' })`—给 ModeWidget。

---

## Bug 残留

### B1 — ChatView header 仍用 getState()
`ChatView.tsx` L227 `useStore.getState().sessions.find(...)` → 应改为 `useStore(s => ...)`。

### B2 — /export 查找字段错误
`InputBar.tsx` L70 `s.source === sessionId` → `sessionId` 是 id 不是 source。

### B3 — Settings 多处 getState()
`Settings.tsx` L81 ccHidden、L318 activeAgent、L322 agents.map → 不响应式。

### B4 — ErrorBoundary "Prism Desktop"
→ 改为 "Pylon"。

### B5 — profileEditor includes() 引用比较 → 可能重复创建 profile

### B6 — ChatView toolCallId 可能 undefined → ID 冲突

### B7 — peri:error 对象 payload → "[object Object]"

---

## 清理

- C1 — MessageBubble.tsx 62 行死代码
- C2 — unused imports (ChatView useCallback/invoke, InputBar readTextFile)
- C3 — CSS 孤儿类 15 处
- C4 — React.memo 缺失 (InputBar/StatusBar/ControlCenter)
