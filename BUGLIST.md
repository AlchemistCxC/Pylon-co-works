# Pylon Bug 清单

> 宫木云汇报，Riccati 记录。

---

## B1 — mcpServers 格式不兼容（🔴 P0）

**症状**：连 Peri 时报 `Invalid params: Input should be a valid list`。

**根因**：`acp.rs` L88-91 `session/new` 传 `"mcpServers": {}`。ACP 标准类型是 list。Peri Rust 端宽松接受 `{}`，但某层 Python/Pydantic 校验拒绝对象。

**修复**：改为 `"mcpServers": []`。

---

## B2 — chat header 显示 raw session ID（🟡 P1）

**症状**：会话左上角一直显示 `smrzv7udx` 或类似字符串。

**根因**：ChatView 在 autoName 为空且 name 不以 `session-` 开头时 fallback 到 sessionId。新会话第一条消息到达前无 autoName。

**修复**：首次渲染显示"新会话 · 时间"，收到首条消息后替换为 autoName。

---

## B3 — 左侧栏折叠按钮找不到（🟡 P1）

**修复**：移到中间栏（ChatView + ControlCenter 交界处左上角），常驻浮动按钮。

---

## B4 — 心电图波形循环重复（🟡 P1）

**症状**：波移动但像固定动画循环。

**根因**：每周期 P-Q-R-S-T 相位时长硬编码。Math.random() 噪声只加在 y 值，相位时间不变 → 所有心跳时间结构相同。

**修复**：每周期对相位加时序 jitter：

```typescript
const jitter = (Math.random() - 0.5) * 2 * noiseScale * 0.02
const phStart = ph.start + jitter
const phEnd = ph.end + jitter * 0.5
```

每个心跳的 P 波时长、QRS 宽度都不同 → 永不重复。

---

## B5 — 历史会话无记录（🔴 P0）

**症状**：点击有 periId 的会话无历史消息。

**根因**：`session/load` 重放 history 的 `session/update` 事件，source 字段不匹配当前 session。

**验证**：console.log 看 `peri:update` 是否到达、source 是否正确。

---

## B6 — 会话设置 UI 难看（🟡 P1）

**修复**：重组 CSS——平台下拉/prompt textarea/skills/hooks 标签行需要更好间距和排版。

---

## B7 — 删除按钮不在左栏最右侧（🟡 P1）

**修复**：`.session-del { margin-left: auto; }`
