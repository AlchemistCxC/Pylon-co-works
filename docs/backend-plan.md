# Prism Desktop — 后端实现规划书

> 查证来源：Peri 源码 `peri-tui/src/acp_stdio/`、`acp-hub/src/bin/test_child.rs`、`peri-tui/src/main.rs`

---

## 一、启动 Peri ACP 进程

**命令**：
```
peri.exe acp --cwd "G:\\Project\\prism" --model deepseek-v4-flash
```

**查证**：`peri-tui/src/main.rs:143-153`
```
Commands::Acp { cwd, model, agent }
  → rt.block_on(acp_stdio::run_acp_stdio(cwd))
```

**Rust 实现**：
```rust
let mut child = Command::new("peri.exe")
    .args(["acp", "--cwd", &cwd, "--model", &model])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()?;
```

---

## 二、ACP 协议

**查证**：`acp-hub/src/bin/test_child.rs:26-80`，格式为 JSON-RPC 2.0，一行一个 JSON 对象。

### 2.1 Initialize

→ 发送：
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"capabilities":{},"clientInfo":{"name":"prism-desktop","version":"0.1.0"}}}
```

← 返回：
```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"serverInfo":{"name":"peri-acp","version":"..."}}}
```

**查证**：`peri-tui/src/acp_stdio/mod.rs:33-41`

### 2.2 session/new

→ 发送：
```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"G:\\Project\\prism"}}
```

← 返回：
```json
{"jsonrpc":"2.0","id":2,"result":{"sessionId":"thread-xxx"}}
```

**查证**：`peri-tui/src/acp_stdio/session/create.rs:24-46`

### 2.3 prompt

→ 发送：
```json
{"jsonrpc":"2.0","id":3,"method":"prompt","params":{"sessionId":"thread-xxx","prompt":[{"type":"text","text":"帮我查日志"}]}}
```

← 流式通知（多个）：
```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"thread-xxx","update":{"type":"content_chunk","content":{"type":"text","text":"好"}}}}
```

← 最终响应：
```json
{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}
```

**查证**：
- PromptRequest 结构：`peri-tui/src/acp_stdio/session/prompt.rs:26-41` — `req.session_id` + `req.prompt`（Vec\<ContentBlock\>）
- ContentBlock::Text 结构：`{type:"text", text:"..."}`

### 2.4 session/update 通知变体

**查证**：`peri-acp/src/dispatch/session_replay.rs:38` + `peri-agent/src/agent/events.rs:186-226`

| update.type | 含义 | 前端处理 |
|:--|:--|:--|
| `content_chunk` | LLM 逐字输出 | 追加到气泡 |
| `tool_call` | 工具调用开始 | 插入 `● tool_name` |
| `tool_call_update` | 工具调用结果 | 更新工具卡片 |
| `usage_update` | Token 用量 | 更新状态栏 |

### 2.5 SetSessionMode

→ 发送：
```json
{"jsonrpc":"2.0","id":4,"method":"session/set_mode","params":{"sessionId":"thread-xxx","mode":"bypass"}}
```

**查证**：`peri-tui/src/acp_stdio/mod.rs:86-95`
四种 mode：`default`, `accept_edit`, `auto`, `bypass`

---

## 三、Tauri 后端架构

### 3.1 模块结构

```
src-tauri/src/
├── lib.rs              # Tauri setup + 全局 State
├── acp.rs              # ACP client：spawn peri.exe → JSON-RPC
├── prism.rs            # Prism HTTP client（预留）
├── session.rs          # source → peri_session_id 映射
└── commands.rs         # Tauri commands
```

### 3.2 全局 State

```rust
struct AppContext {
    acp: Mutex<AcpClient>,           // peri.exe 子进程 + stdin/stdout
    sessions: Mutex<HashMap<String, SessionState>>,
}

struct SessionState {
    peri_session_id: String,
    model: String,
    persona: String,
    created_at: Instant,
}
```

### 3.3 AcpClient 结构

```rust
struct AcpClient {
    child: Child,                    // 子进程句柄
    stdin: BufWriter<ChildStdin>,    // 写入端
    stdout: BufReader<ChildStdout>,  // 读取端
    next_id: AtomicU64,              // JSON-RPC id 计数器
}
```

**关键操作**：

| 方法 | 实现 |
|:--|:--|
| `new()` | spawn `peri.exe acp` → send initialize → 验证响应 |
| `send_request(method, params)` | 序列化 JSON → `writeln!(stdin)` → `flush` |
| `read_response()` | `stdout.lines()` → 反序列化 → 区分 response/notification |
| `new_session()` | send_request("session/new", {cwd}) → 提取 sessionId |
| `prompt(session_id, text)` | send_request("prompt", {sessionId, prompt:[{type:"text",text}]}) |
| `set_mode(session_id, mode)` | send_request("session/set_mode", {sessionId, mode}) |

---

## 四、前端对接

### 4.1 ChatView（替换 mock messages）

**当前**：硬编码 `messages` 数组。

**实现后**：
1. 用户点击会话 → Tauri command `new_session` → 获取 `session_id`
2. 输入框发送 → Tauri command `prompt(session_id, text)`
3. 后端事件流 → `emit("peri:text-chunk", {message_id, chunk})`
4. ChatView `listen("peri:text-chunk")` → 逐字追加

### 4.2 流式渲染

```
前端 state:
  messages: Message[]

listen("peri:text-chunk", ({message_id, chunk}) => {
  setMessages(prev => prev.map(m =>
    m.id === message_id
      ? {...m, content: m.content + chunk}
      : m
  ))
})

listen("peri:tool-start", ({tool_call_id, name, input}) => {
  setMessages(prev => [...prev, {
    id: tool_call_id, role: "tool",
    toolName: name, toolInput: input, toolRunning: true
  }])
})

listen("peri:tool-end", ({tool_call_id, output}) => {
  setMessages(prev => prev.map(m =>
    m.id === tool_call_id ? {...m, toolOutput: output, toolRunning: false} : m
  ))
})
```

### 4.3 InputBar 发送

```tsx
const send = async () => {
  if (!value.trim() || !sessionId) return
  await invoke("prompt", { sessionId, content: value })
  setValue("")
}
```

### 4.4 StatusBar 实时数据

```
listen("peri:usage-update", ({tokensUsed, tokensMax, cacheHit}) => {
  setTokens({tokensUsed, tokensMax, cacheHit})
})
```

### 4.5 模式切换

```
listen("peri:mode-change", async (mode) => {
  await invoke("set_mode", { sessionId, mode })
})
```

---

## 五、开发分阶段

| 阶段 | 内容 | 验证方式 |
|:--|:--|:--|
| **P1** | `acp.rs` — spawn peri.exe + initialize | `cargo test` 验证握手 |
| **P2** | session/new + prompt | `cargo test` 模拟一轮对话 |
| **P3** | Tauri commands + events + 前端对接 | 浏览器输入消息 → Peri 回复 |
| **P4** | 流式渲染 | 逐字显示 |
| **P5** | session 映射表 | 多会话切换 |
| **P6** | `prism.rs` — HTTP client | PrismSheet 数据 |

---

## 六、关键依赖

```toml
[dependencies]
tauri = "2"
serde = "1"
serde_json = "1"
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", features = ["json"] }  # Prism HTTP
```

**不需要引入 `agent-client-protocol` crate** ——我们只需要序列化/反序列化 JSON-RPC，用 `serde_json` 直接构造即可。
