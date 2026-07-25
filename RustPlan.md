# RustPlan — Pylon 后端

## ✅ 已完成（11/11）

- R1 export_session 协议修复
- R2 tokio task 泄漏 (handle.abort)
- R3 sessionId 过滤
- R4 switch_agent 重连 + kill 旧进程
- R5 unwrap/expect 部分清理 + PylonError
- R6 switch_agent 不必要 clone 已消
- R7 spawn() 死代码已删

## backend-plan-v2 已完成（8/8）

- P0-1 clean shutdown
- P0-2 session/close
- P1-1 崩溃检测 + reconnect + agent_status
- P1-2 session/cancel
- P1-3 per-session cwd
- P1-4 结构化错误 PylonError + From impl
- P2-1+2+4 通知全覆盖 (userMessageChunk/plan/config/etc)
- P2-3 mpsc 通道

## 🔜 P3 待做

### 模块拆分
`lib.rs` 317 行 → `commands/session.rs` + `persist.rs` + `agent.rs`

### agents.yaml 热加载 + default:true

## 📡 前端接口（updated）

| 命令 | 签名 | 返回 |
|:--|:--|:--|
| `new_session` | `(source, persona, cwd?)` | `{sessionId, modes, configOptions}` |
| `send_message` | `(source, content, ...)` | `peri_id` |
| `set_mode` | `(source, mode)` | `()` |
| `set_config_option` | `(source, key, value)` | configOptionUpdate |
| `close_session` | `(source)` | `()` |
| `cancel_prompt` | `(source)` | `()` |
| `switch_agent` | `(name)` | `()` |
| `reconnect_agent` | `()` | `()` |
| `agent_status` | `()` | `{agent, crashed}` |
