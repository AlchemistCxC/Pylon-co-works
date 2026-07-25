# Pylon 后端功能规划书

> 查证来源：Peri 源码 `peri-tui/src/acp_stdio/`、`peri-acp/src/event/mapper.rs`、`peri-acp/src/session/event_sink.rs`
> 当前行数：572（acp.rs 225 + lib.rs 317 + agent_config.rs 27 + main.rs 3）

---

## 一、会话生命周期闭环

### 1.1 session/close

**功能**：前端关闭 tab / 删除会话 → 通知 agent 释放 ThreadStore 资源 + 取消运行中 prompt。

**协议**（Peri `control.rs:35-47`）：
```json
→ {"method":"session/close","params":{"sessionId":"…"}}
← {"result":{}}
```

**实现**：
- `acp.rs` 加 `close_session(session_id)` 方法，复用 `call_async`
- `lib.rs` 加 `#[tauri::command] close_session(source)` — 查 sessions map 取 peri_id → acp.close → sessions.remove
- 前端 tab 关闭 / 侧栏删除时 invoke

**行数**：~30

### 1.2 session/cancel

**功能**：用户点停止按钮 → 中断正在运行的 prompt（不等 300s 超时）。

**协议**：cancel 是 notification（无 id），Peri `mod.rs:97-106`
```json
→ {"method":"session/cancel","params":{"sessionId":"…"}}
```

**实现**：
- `acp.rs` 加 `cancel_session(session_id)` — 直接写 stdin，fire-and-forget（不等响应）
- `lib.rs` 加 `#[tauri::command] cancel_prompt(source)` — 查 peri_id → acp.cancel
- 并发控制：`send_message` 目前独占 rx loop，cancel 后需要让 loop 退出。方案：加 `CancellationToken` 到 SessionInfo，select! 三个分支

**行数**：~50

### 1.3 per-session cwd

**功能**：每个会话独立工作目录。前端 SessionSettings 已有 `workdir` 字段，但 `new_session` 的 Rust 端未接收。

**现状**：`new_session` 调用 `state.acp.lock().await.new_session(cwd)`，`cwd` 取自 active agent 的 `agent.cwd`——所有会话共用同一个目录。

**协议**：Peri `session/new` 的 `cwd` 参数决定 ThreadStore 路径 + skill 发现范围（create.rs:30-31）。

**实现**：
- `new_session` 加 `cwd: Option<String>` 参数
- `cwd.unwrap_or_else(|| agent.cwd.clone())` — 前端没传则回退 agent 默认值
- `SessionInfo` 加 `cwd: String` 字段，所有后续 command（send_message/close/set_mode）从 SessionInfo 取 cwd 而非每次从 agent 取

**行数**：~25

---

## 二、协议通知全覆盖

### 2.1 userMessageChunk

**协议**：Peri `session/load` 重放历史时，用户消息以 `sessionUpdate: "userMessageChunk"` 发送（mapper.rs:191-199）。

**现状**：Pylon `send_message` 的 notification loop 只匹配 `session/update` 但未处理此变体，load 重放时用户消息被静默丢弃。

**实现**：notification loop 加分支 → emit `peri:user` 事件（和 `send_message` L82 格式一致）

**行数**：~15

### 2.2 plan（Todo 任务列表）

**协议**：Peri 开启 Plan 模式时发送 `sessionUpdate: "plan"`（mapper.rs:126-150）
```json
{"sessionUpdate":"plan","entries":[{"content":"…","priority":"Medium","status":"InProgress"}]}
```

**实现**：
- notification loop 加分支 → emit `peri:plan` 事件
- 内容：`{entries: [{content, priority, status}]}`

**行数**：~15

### 2.3 availableCommandsUpdate + configOptionUpdate + sessionInfoUpdate

**协议**：session/new 和 set_mode 后 Peri 推送可用命令 / 配置选项 / 会话元数据。

**实现**：notification loop 加三个分支 → emit 对应前端事件，供状态栏/设置面板消费。

**行数**：~30

---

## 三、健壮性

### 3.1 子进程崩溃检测 + 自动重连

**功能**：peri.exe 异常退出时检测并通知前端，支持自动/手动重连。

**实现**：
- `acp.rs`：spawn 后加 `tokio::spawn` 监控 `child.wait()` → exit status → set `AtomicBool crashed` + 通知
- `lib.rs`：`switch_agent` 已有 kill + reconnect，扩展为 `reconnect()` 复用
- 前端事件：`peri:agent-status` (`{status: "connected"|"disconnected"|"reconnecting"}`)
- 重连策略：首次即时，后续指数退避 1s/2s/4s/… 上限 30s，最多 5 次

**行数**：~80

### 3.2 结构化错误类型

**功能**：替换遍地 `String` 为 `thiserror` enum，区分错误来源（ACP/RPC/Timeout/Killed）。

**实现**：
```rust
#[derive(Debug, thiserror::Error)]
pub enum PylonError {
    #[error("ACP: {0}")]
    Acp(String),
    #[error("RPC error: {0}")]
    Rpc(serde_json::Value),
    #[error("timeout after {0}s")]
    Timeout(u64),
    #[error("agent crashed")]
    AgentCrashed,
    #[error("session not found: {0}")]
    SessionNotFound(String),
}
```
- 所有 `Result<T, String>` → `Result<T, PylonError>`
- Tauri command 返回时 `PylonError` 实现 `Into<tauri::InvokeError>` 或序列化为 string

**行数**：~50（新文件 `error.rs`）+ 分散替换 ~30

### 3.3 app 关闭时 clean shutdown

**功能**：窗口关闭 → kill 子进程 → 等待退出 → 防止 Windows 孤儿进程。

**实现**：
- Tauri `on_window_event(CloseRequested)` → `state.acp.lock().kill()` 
- 如果 `switch_agent` 已修 B1，这里只需在 `run()` 的 builder 里加 `.on_window_event`

**行数**：~15

---

## 四、扩展性

### 4.1 stdin 写入改为 mpsc channel

**功能**：消除 `BufWriter<ChildStdin>` 上的 Mutex 锁竞争。

**实现**：
- `acp.rs` 加一个 `tokio::spawn` 单写线程：`while let Some(line) = write_rx.recv().await { writeln!(stdin, "{}", line) }`
- `call_async` / `send_prompt_atomic` / `cancel_session` → 序列化 JSON 后 `write_tx.send(line)`
- `stdin: Arc<Mutex<BufWriter>>` → `write_tx: mpsc::UnboundedSender<String>`

**行数**：~40（替换现有 Mutex 逻辑）

### 4.2 模块拆分

**功能**：`lib.rs`（317 行）拆为清晰的子模块。

**实现**：
```
src/
├── main.rs
├── lib.rs              # Tauri setup + AppState（~60 行）
├── acp.rs              # ACP 客户端（不变，~250 行）
├── agent_config.rs     # 不变
├── error.rs            # 结构化错误（新增，~50 行）
├── commands/
│   ├── mod.rs          # 重导出
│   ├── session.rs      # new_session, send_message, close_session, cancel_prompt, set_mode（~150 行）
│   ├── persist.rs      # load_persisted_session, list_persisted_sessions, export_session（~100 行）
│   └── agent.rs        # list_agents, switch_agent, reconnect（~60 行）
```

**行数**：~370（与现状接近，纯重组）

### 4.3 agents.yaml 热加载 + 默认 agent

**功能**：
- `agents.yaml` 修改后无需重启
- `default: true` 字段替代硬编码 `"peri"`

**实现**：
- `agent_config.rs` 加 `watch()` → 文件修改时发 `tokio::sync::watch` 通知
- `AppState` 中 `agents: Arc<RwLock<HashMap>>` 替换 `HashMap`
- 前端加 `reload_agents` command

**行数**：~40

---

## 五、ACP 协议补全（低优先级扩展）

| 方法 | Peri 支持 | Pylon 用途 | 行数 |
|:--|:--|:--|:--|
| `session/resume` | ✅ | 断线重连，注入新 frozen data | ~30 |
| `session/fork` | ✅ | 从历史分支新对话 | ~40 |
| `session/set_config_option` | ✅ | 运行时改 model / 参数 | ~25 |
| ContentBlock image | ✅ | 传图片（已有协议，Pylon 未用） | ~30 |

---

## 六、优先级排序

| 阶段 | 条目 | 行数 | 理由 |
|:--|:--|:--|:--|
| **P0-1** | 3.3 clean shutdown | ~15 | 关窗口留僵尸进程——必须补 |
| **P0-2** | 1.1 session/close | ~30 | 前端删会话/关 tab → agent 端不知道，ThreadStore 资源泄漏 |
| **P1-1** | 3.1 崩溃检测+重连 | ~80 | peri.exe 挂了用户不知道，所有 command 静默失败 |
| **P1-2** | 1.2 session/cancel | ~50 | 用户点停止只能等 300s 超时 |
| **P1-3** | 1.3 per-session cwd | ~25 | 前端 SessionSettings 有 workdir 字段，Rust 的 new_session 没接收 |
| **P1-4** | 3.2 结构化错误 | ~80 | 当前 String 错误功能正确，优雅但不阻塞——延后至此 |
| **P2-1** | 2.1 userMessageChunk | ~15 | load 重放缺用户消息 |
| **P2-2** | 2.2 plan | ~15 | Plan 模式输出不可见 |
| **P2-3** | 4.1 mpsc channel | ~40 | 消除 stdin 写锁竞争（当前够用，未来优化） |
| **P2-4** | 2.3 其他通知 | ~30 | 状态栏信息完整度 |
| **P3-1** | 4.2 模块拆分 | ~0（重组） | 不增功能，改善可维护性 |
| **P3-2** | 4.3 热加载 | ~40 | 非关键路径 |
| **P4** | 五、协议补全 | ~125 | 低频功能（resume/fork/set_config_option/image） |

**总计**：P0 ~45 行，P1 ~235 行，P2 ~100 行，P3 ~40 行，P4 ~125 行。
完成全部后 ~1120 行（约翻倍）。

---

## 七、不做的事项

- **Prism HTTP 集成**（`prism.rs`）— 你明确延后
- **ContentBlock image** — 前端没接图片输入时后端做了白做
- **TCP transport** — 当前 subprocess 够用
- **session/update_config**（Peri 自定义扩展）— Pylon 走标准 ACP，不依赖 Peri 私有 API
- **`AcpClient::spawn()` 旧 API** — 已删（B3）
