# RustPlan — Pylon 后端待修

> 给后端开发者。基于 2026-07-26 全面审计。

---

## P0 — 立即修复

### 1. export_session ACP 协议错误

**文件**: `src-tauri/src/lib.rs:245-249`

```rust
// ❌ 当前
if let Some(chunk) = update.get("agent_message_chunk") {
    if let Some(text) = chunk.get("content").and_then(|c| c.get("text")) {

// ✅ 正确
if update.get("sessionUpdate").and_then(|v| v.as_str()) == Some("agentMessageChunk") {
    if let Some(text) = update.get("content").and_then(|c| c.get("text")).and_then(|v| v.as_str()) {
```

ACP 协议: content 与 sessionUpdate 同级，不在嵌套对象内。变体名 camelCase。

### 2. load_persisted_session tokio task 泄漏

**文件**: `src-tauri/src/lib.rs:188-198`

每次调用 spawn 一个永不退出的 while loop。JoinHandle 被 drop，task 永远运行。多次调用 = 多个泄露 task。

修复：加 oneshot 关闭信号，在 session 关闭/new 时发送。

### 3. switch_agent 不重连

**文件**: `src-tauri/src/lib.rs:165-172`

只改 active_agent 字符串，AcpClient 仍连旧进程。需在 switch 时重新 connect()。

### 4. 默认 agent 选 peri（已修 ✅）

`db3be37` — 显式选 `peri`，不再靠 BTreeMap 排序。

---

## P1 — 建议

### 5. 清理 unwrap/expect

`acp.rs:194`、`lib.rs:233` 等 11 处。建议替换为 proper error。

### 6. switch_agent 删不必要 clone

`lib.rs:166` `let agents = state.agents.clone()` — 直接 `state.agents.contains_key(&name)` 即可。

### 7. 删 `AcpClient::spawn()` 死代码

`acp.rs:38-48` — 未被任何路径调用。

---

## 验证

`cargo check` 通过 → `cargo build --release`。
`perl.exe acp` 必须在 PATH 或 agents.yaml 指定绝对路径。
