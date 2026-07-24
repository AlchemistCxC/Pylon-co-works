# Prism Desktop 完备化设计书

> 给 coder。写完所有功能后**不要 build**，先 `git commit`。然后我审计，审计完会在这份文件同目录下生成 `REVIEW-v2.md`。我已经开了 cron 盯着 commit。

---

## 一、总体目标

三项改造，按优先级排列：

| 优先级 | 模块 | 目标 |
|:--|:--|:--|
| P0 | Agent Registry | 多 agent 支持 + 路径可配置 + 消除所有硬编码 |
| P1 | 会话持久化 | 重启后恢复会话列表和对话历史 |
| P2 | 消息导出 | 会话导出为 Markdown/JSONL |

---

## 二、Agent Registry（P0）

### 当前问题

`lib.rs:174-176` 硬编码了 Peri 的路径和参数：

```rust
AcpClient::spawn(
    "F:\\A-I\\Agent\\Peri\\target\\release\\peri.exe",
    "G:\\Project\\prism",
    "deepseek-v4-flash",
)
```

`acp.rs` 的 `spawn()` 签名绑死了子进程模式，无法接入远程 agent 或不同传输。

### 设计方案

在项目根目录新增 `agents.yaml`：

```yaml
agents:
  peri:
    name: Peri
    transport: subprocess
    exe: F:\A-I\Agent\Peri\target\release\peri.exe
    args: ["acp", "--model", "deepseek-v4-flash"]
    cwd: G:\Project\prism
  hermes:
    name: Hermes
    transport: subprocess
    exe: hermes
    args: ["acp"]
    cwd: .
```

Rust 端改动（`src-tauri/src/` 下新增 `agent_config.rs`）：

```rust
// agent_config.rs — 加载 agents.yaml
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
struct AgentConfigFile {
    agents: HashMap<String, AgentDef>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentDef {
    pub name: String,
    pub transport: String,           // "subprocess" | reserved: "tcp"
    pub exe: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}
```

`acp.rs` 改动——暴露按 `AgentDef` 连接的入口，原有内部逻辑不动：

```rust
impl AcpClient {
    /// 新入口：从 AgentDef 连接（替代硬编码 spawn）
    pub async fn connect(agent: &AgentDef) -> Result<Self, String> {
        match agent.transport.as_str() {
            "subprocess" => {
                let mut cmd = Command::new(&agent.exe);
                cmd.args(&agent.args)
                   .stdin(Stdio::piped())
                   .stdout(Stdio::piped())
                   .stderr(Stdio::piped());
                if let Some(cwd) = &agent.cwd {
                    cmd.current_dir(cwd);
                }
                for (k, v) in &agent.env {
                    cmd.env(k, v);
                }
                let mut child = cmd.spawn()...;
                // reader 线程、stderr drain、broadcast、initialize — 以下全部不变
            }
        }
    }
}
```

`lib.rs` 改动——`run()` 中加载配置、选择默认 agent：

```rust
pub fn run() {
    let agents = agent_config::load();
    let default_agent = agents.get("peri").expect("no peri agent configured");

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let acp = Arc::new(AcpClient::connect(&default_agent).await?);
        // ... 以下不变
    });
}
```

新增 Tauri command 供前端切换 agent：

```rust
#[tauri::command]
async fn list_agents() -> Result<Vec<AgentInfo>, String> { ... }

#[tauri::command]
async fn switch_agent(name: String) -> Result<(), String> { ... }
```

### 参考

- `src-tauri/src/acp.rs:38-64` — spawn 当前实现
- `src-tauri/src/lib.rs:154-189` — run() 当前实现
- Peri ACP 入口：`F:\A-I\Agent\Peri\peri-tui\src\acp_stdio\mod.rs`
- Hermes ACP 入口：`F:\Hermes\hermes-agent\acp_adapter\entry.py:262`（`acp.run_agent()`）

---

## 三、会话持久化（P1）

### 关键发现：Peri ACP 已支持完整会话生命周期

**证据**（`F:\A-I\Agent\Peri\peri-tui\src\acp_stdio\session\create.rs`）：

| ACP 方法 | 处理器 | 功能 |
|:--|:--|:--|
| `session/new` | `handle_new` (L24) | 创建 ThreadStore 线程，冻结系统提示词 |
| `session/load` | `handle_load` (L129) | 从 ThreadStore 加载完整历史，**重放进 `session/update` 流** |
| `session/resume` | `handle_resume` (L206) | 恢复已有会话 |
| `session/fork` | `handle_fork` (L257) | 复制会话历史到新线程 |
| `session/list` | `list_sessions_as_info` | 列出 ThreadStore 中所有持久化会话 |

**ThreadStore 是持久化的**。对话历史存盘，`session/load` 把完整消息链以 `session/update` 事件重放——ChatView 不需要额外逻辑，照常渲染即可。

### 设计方案

**`acp.rs` — 新增两个方法：**

```rust
impl AcpClient {
    /// 加载已有会话：调用 session/load，重放历史后返回
    pub async fn load_session(&self, session_id: &str, cwd: &str) -> Result<(), String> {
        let _response = self.call_async("session/load", serde_json::json!({
            "sessionId": session_id,
            "cwd": cwd,
        })).await?;
        // 注意：Peri 在 respond 之前已通过 session/update 重放历史
        // 前端只需在调用 load_session 前注册 listen
        Ok(())
    }

    /// 列出 ThreadStore 中所有持久化会话
    pub async fn list_sessions(&self, cwd_filter: Option<&str>) -> Result<Vec<serde_json::Value>, String> {
        let params = if let Some(cwd) = cwd_filter {
            serde_json::json!({ "cwd": cwd })
        } else {
            serde_json::json!({})
        };
        self.call_async("session/list", params).await
    }
}
```

**`lib.rs` — 新增 commands：**

```rust
#[tauri::command]
async fn load_session(state: ..., source: String, session_id: String) -> Result<(), String> {
    state.acp.load_session(&session_id, "G:\\Project\\prism").await
}

#[tauri::command]
async fn list_persisted_sessions(state: ...) -> Result<Vec<serde_json::Value>, String> {
    state.acp.list_sessions(Some("G:\\Project\\prism")).await
}
```

**前端 — Zustand store：**

```typescript
// store.ts — Session 接口扩展
interface Session {
    id: string;           // 前端 session ID
    periId: string;       // Peri ThreadStore session ID（持久化的钥匙）
    name: string;
    source: string;
    profileId: string;
}

// 启动时恢复
async function restoreSessions() {
    const periSessions = await invoke('list_persisted_sessions');
    const localSessions = JSON.parse(localStorage.getItem('sessions') || '[]');
    // 合并：Peri 有但前端没记录的 → 恢复；前端有但 Peri 没有的 → 删
}

// localStorage 只存最小映射
function persistSessions() {
    const sessions = useStore.getState().sessions;
    localStorage.setItem('sessions', JSON.stringify(
        sessions.map(s => ({ id: s.id, periId: s.periId, name: s.name, source: s.source, profileId: s.profileId }))
    ));
}
```

**Sidebar 改动：**

```typescript
// 点击会话时判断：有 periId → session/load，无 → session/new
const handleSelect = async (id: string) => {
    const s = sessions.find(x => x.id === id);
    if (s?.periId) {
        await invoke('load_session', { source: id, sessionId: s.periId });
    } else {
        const periId = await invoke('new_session', { source: id, persona });
        setSessionPeriId(id, periId);
    }
};
```

### 参考

- Peri `session/load` 源码：`F:\A-I\Agent\Peri\peri-tui\src\acp_stdio\session\create.rs:128-203`
- Peri `session/list` 源码：`F:\A-I\Agent\Peri\peri-acp\src\dispatch\list_sessions.rs:8-35`
- Peri ThreadStore：`F:\A-I\Agent\Peri\peri-agent\src\thread\`（持久化后端）
- 当前 `acp.rs` `new_session`：L174-182（参照实现 `call_async` 模式）
- 当前前端 `Sidebar.tsx` `handleSelect`：L41-53

---

## 四、消息导出（P2）

### 设计方案

新增 Tauri command，读取 Peri ThreadStore 的完整消息历史，输出 Markdown：

```rust
#[tauri::command]
async fn export_session(
    session_id: String,
    format: String, // "markdown" | "jsonl"
    output_path: String,
) -> Result<(), String> {
    // 调 session/load 拿到完整消息链
    // 按 format 格式化写入 output_path
}
```

前端调用——Sidebar 右键菜单或 ChatView 顶栏按钮触发文件保存对话框：

```typescript
import { save } from '@tauri-apps/plugin-dialog';

async function exportSession(sessionId: string, periId: string) {
    const path = await save({ filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (path) await invoke('export_session', { sessionId: periId, format: 'markdown', outputPath: path });
}
```

### 参考

- Tauri dialog plugin: `@tauri-apps/plugin-dialog`（已安装）
- Peri 消息格式：`F:\A-I\Agent\Peri\peri-agent\src\messages\`（BaseMessage 结构）

---

## 五、改动量预估

| 文件 | 操作 | 预估行数 |
|:--|:--|:--|
| `agents.yaml` | 新建 | ~12 |
| `src-tauri/src/agent_config.rs` | 新建 | ~40 |
| `src-tauri/src/acp.rs` | 改 spawn→connect，加 load/list/export | +50 |
| `src-tauri/src/lib.rs` | 改 run()，加 4 个 commands | +60 |
| `src/store.ts` | Session 接口扩展 + localStorage | +30 |
| `src/components/Sidebar.tsx` | 会话恢复 + load 逻辑 | +25 |
| `src/components/chat/ChatView.tsx` | 导出按钮 | +15 |

**总计约 230 行**，不改现有架构。

---

## 六、给 coder 的话

1. 做完上述所有功能后，**不要 build，不要 `npm run build`，不要 `cargo build`**。
2. 先 `git add -A && git commit -m "feat: agent registry + session persistence + export"`。
3. **我已经开了一个 cron job 盯着这个仓库**。你 commit 之后我会在几分钟内收到通知。
4. 我会审计全部新增代码，然后**在同一目录下生成 `REVIEW-v2.md`**，里面是逐项的改进意见。
5. 你看完 `REVIEW-v2.md` 之后再决定是否 build 和修改。
