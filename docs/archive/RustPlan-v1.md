# RustPlan-v1.md — 后端功能规划书：崩溃自动重连 + Session Inspector

> 规划日期：2026-07-31
> 规划人：Riccati（后端负责人）
> 状态：✅ 已全部执行完毕（2026-07-31，8 commit：57d1d6f→845fa61，76 测试全绿，GUI 手动验收待补）

---

## 〇、项目位置索引

| 项 | 位置 |
|:--|:--|
| 项目根 | `G:\Project\prism-desktop` |
| 后端源码 | `src-tauri/src/`（11 文件，4,826 行） |
| 主状态机 + Tauri 命令 | `src-tauri/src/lib.rs`（1,823 行） |
| ACP 客户端 + 参数构造 + fake 测试 | `src-tauri/src/acp.rs`（1,443 行） |
| Agent 生命周期状态 | `src-tauri/src/agent_runtime.rs`（145 行） |
| MCP 校验/序列化 | `src-tauri/src/mcp.rs` |
| Agent 注册表 | `agents.yaml`（项目根） |
| 单元测试 | `src-tauri/src/*.rs` 内 `#[cfg(test)]`（当前 71 个） |
| 前端契约 | `docs/api-reference.md` |
| Hermes wire 验证脚本 | `scripts/hermes-wire-test.py` |

当前后端状态：cargo check 零 warning、71 测试全绿、Hermes 0.18.2 真实 wire 验证通过、ACP/MCP 双层官方 schema 类型化。

---

## 一、P0-1 崩溃自动重连（优先级最高）

### 1.1 现状与根因

| 环节 | 现状 | 源码位置 |
|:--|:--|:--|
| 崩溃检测 | ACP reader 线程 stdout EOF → 发 `NOTIF_AGENT_CRASHED` → dispatcher 置 Crashed + emit `peri:agent-status` | acp.rs reader 尾部（stdout closed 分支）；lib.rs:473-502 |
| 崩溃后恢复 | 仅状态置位 + 前端提示，**需用户手动点 reconnect** | lib.rs:1442-1446 `reconnect_agent` |
| 手动重连 | `connect_and_replace(None, Reconnecting, "reconnect")` | lib.rs:1442 + lib.rs:1050 `connect_and_replace` |

**根因**：无自动恢复层。Windows 上子进程崩溃/被杀是高频场景（OOM、外部 kill、Peri 自身 bug），每次都要用户手动救。

### 1.2 实现方案

#### A. 退避常量 + 计算（agent_runtime.rs 扩展）

在 `agent_runtime.rs`（145 行，`AgentLifecycleStatus` 定义后）追加：

```rust
/// 自动重连：最大尝试次数（2s+4s+8s+16s+32s = 62s 后放弃）
pub const MAX_RECONNECT_ATTEMPTS: u32 = 5;

/// 指数退避：attempt 从 1 开始 → 2s/4s/8s/16s/32s（封顶 30s）
pub fn reconnect_backoff_ms(attempt: u32) -> u64 {
    let exp = 1u64 << attempt.min(5);          // 2^attempt，封顶 2^5=32s
    (exp * 1000).min(30_000)
}
```

单测（agent_runtime.rs tests 模块追加）：

```rust
#[test]
fn reconnect_backoff_is_exponential_and_capped() {
    assert_eq!(reconnect_backoff_ms(1), 2_000);
    assert_eq!(reconnect_backoff_ms(2), 4_000);
    assert_eq!(reconnect_backoff_ms(3), 8_000);
    assert_eq!(reconnect_backoff_ms(6), 30_000); // 封顶
}
```

#### B. 重连防重入标志（lib.rs AppState）

`AppState`（lib.rs:32-48）加字段：

```rust
pub struct AppState {
    // ...现有字段...
    /// 自动重连进行中（防 dispatcher 多次崩溃通知重复调度）
    auto_reconnect_active: Arc<AtomicBool>,
}
```

`run()` 的 `.manage(AppState { ... })`（lib.rs:1720-1735）初始化：

```rust
auto_reconnect_active: Arc::new(AtomicBool::new(false)),
```

#### C. 自动重连任务（lib.rs dispatcher 崩溃分支追加）

lib.rs:473-502 的 `NOTIF_AGENT_CRASHED` 分支，在 emit `peri:agent-status` 之后追加调度：

```rust
// 自动重连：崩溃后指数退避自动拉起（最多 5 次，~62s）
if state.auto_reconnect_active.swap(true, Ordering::AcqRel) == false {
    let reconnect_state = AppStateHandles {
        acp: state.acp.clone(),
        agent_lifecycle: state.agent_lifecycle.clone(),
        agents: state.agents.clone(),
        active_agent: state.active_agent.clone(),
        agent_runtime: state.agent_runtime.clone(),
        client_generation: state.client_generation.clone(),
        sessions: state.sessions.clone(),
        auto_reconnect_active: state.auto_reconnect_active.clone(),
    };
    let window_for_status = window.clone();
    tokio::spawn(async move {
        let result = run_auto_reconnect(&reconnect_state, &window_for_status).await;
        reconnect_state.auto_reconnect_active.store(false, Ordering::Release);
        if let Err(final_error) = result {
            log::error!("auto-reconnect gave up after {MAX_RECONNECT_ATTEMPTS} attempts: {final_error}");
        }
    });
}
```

> 说明：`AppStateHandles` 是本地小结构（或直接传 `&AppState` 的字段 clone）——**不要**把整个 `AppState` 移进闭包（Tauri manage 的 state 不能 move，只能 clone 字段）。为减少样板，可直接在 dispatcher 内联循环（见下）。

简化实现（不引入 AppStateHandles，直接闭包内循环）：

```rust
let acp2 = state.acp.clone();
let agent_lifecycle2 = state.agent_lifecycle.clone();
let agents2 = state.agents.clone();
let active_agent2 = state.active_agent.clone();
let agent_runtime2 = state.agent_runtime.clone();
let client_generation2 = state.client_generation.clone();
let auto_reconnect2 = state.auto_reconnect_active.clone();
let window2 = window.clone();
tokio::spawn(async move {
    for attempt in 1..=agent_runtime::MAX_RECONNECT_ATTEMPTS {
        tokio::time::sleep(Duration::from_millis(agent_runtime::reconnect_backoff_ms(attempt))).await;
        // 用户已手动 switch/reconnect（generation 变化）→ 放弃自动重连
        let still_stale = agent_runtime2.lock().map(|r| r.status == AgentLifecycleStatus::Crashed).unwrap_or(false);
        if !still_stale { return; }
        let agent = {
            let active_id = active_agent2.lock().ok().map(|v| v.clone()).unwrap_or_default();
            agents2.lock().ok().and_then(|a| a.get(&active_id).cloned())
        };
        let Some(agent) = agent else { return; };
        let _guard = agent_lifecycle2.lock().await;
        // generation 检查：重连期间不应有并发 switch
        if client_generation2.load(Ordering::Acquire) != /* 记录值 */ { return; }
        match AcpClient::connect_with_logs(&agent, None).await {
            Ok(new_acp) => {
                // 复用 replace_agent_client（会清 sessions——与手动 reconnect 语义一致）
                // 注意：replace_agent_client 需要 &AppState，这里用字段级操作；
                // 若实现成本高，改为调用 AppState 的静态化方法（见 1.3）
            }
            Err(e) => log::warn!("auto-reconnect attempt {attempt} failed: {e}"),
        }
    }
});
```

#### D. 复用重连路径（保持 sessions 映射）

`replace_agent_client`（lib.rs:1007-1036）是 &self 方法，且**无条件 `sessions.clear()`**。需求：自动重连**保留** sessions 映射（崩溃前会话可继续），手动 switch/reconnect 保持清空（跨 agent/全新进程语义）。

**方案**：`replace_agent_client` 加参数 `keep_sessions: bool`：

```rust
async fn replace_agent_client(
    &self,
    agent_id: Option<String>,
    new_acp: AcpClient,
    window: tauri::WebviewWindow,
    keep_sessions: bool,
) -> Result<(), String> {
    ...
    let mut old_acp = {
        ...
        let new_generation = self.client_generation.fetch_add(1, Ordering::AcqRel) + 1;
        ...
        if !keep_sessions {
            sessions.clear();
        } else {
            // 保留映射但迁移 generation：通知路由按新代际匹配，旧 session 才能继续收事件
            for session in sessions.values_mut() {
                session.generation = new_generation;
            }
        }
        ...
    };
    ...
}
```

调用点更新：

| 调用点 | keep_sessions | 位置 |
|:--|:--|:--|
| switch_agent | `false`（跨 agent 清空） | lib.rs:1438 |
| 手动 reconnect_agent | `false`（与现状一致） | lib.rs:1442 |
| 自动重连（新增） | `true`（崩溃恢复续会话） | dispatcher 崩溃分支 |

**generation 迁移说明**：`client_generation` +1 后，dispatcher 顶部检查（lib.rs:459/470）与 `session_mapping_matches`（lib.rs:537-548 退化检查）按 session.generation 匹配——不迁移则旧 session 通知全部被拒。迁移后旧 session 若在 Peri 新进程仍有效（Peri ThreadStore 持久化场景），可无缝续聊；若无效（session/load 失败），前端按错误清理，无僵尸风险。

**自动重连闭包复用路径**：`connect_and_replace` 拆出静态辅助 `async fn do_connect_and_replace(handles: &AppStateHandles, window, agent, agent_id, start_status, log_action, keep_sessions)`，手动重连（keep_sessions=false）与自动重连（keep_sessions=true）共用。这符合"机械变换"原则：只搬代码不改变逻辑。

### 1.3 涉及文件与改动量

| 文件 | 改动 | 量 |
|:--|:--|:--|
| `src-tauri/src/agent_runtime.rs` | +2 常量/函数 + 1 测试 | ~15 行 |
| `src-tauri/src/lib.rs` | AppState +1 字段、manage 初始化、崩溃分支 + 自动重连闭包、connect_and_replace 拆静态 | ~80 行 |

### 1.4 测试/验收路线

```
单测：
  ✅ reconnect_backoff_is_exponential_and_capped（agent_runtime.rs）
  ✅ keep_sessions_migrates_generation（lib.rs tests）：
     构造 AppState（fake sessions + client_generation）→ 调
     replace_agent_client(keep_sessions=true) → 断言 sessions 保留
     且每个 session.generation == 新 generation
  ✅ keep_sessions_false_clears_sessions（lib.rs tests）：
     同构造 → keep_sessions=false → 断言 sessions 清空

集成（fake ACP 模式，acp.rs tests 已有 fake 子进程基建）：
  ✅ fake_acp_crash_triggers_auto_reconnect：
     fake ACP 启动后立即 EOF → 断言 dispatcher 收到 crash → 断言
     auto_reconnect_active 置位 → 断言调度了重连（可注入 fake 重连成功）

验收（GUI 手动）：
  1. Pylon 连接 Peri，正常对话（产生 session 映射 + tokens）
  2. 任务管理器 kill peri.exe
  3. 观察状态流：Crashed →（≤2s）→ Reconnecting → Connected
  4. 断言：会话列表仍显示旧会话（映射保留），可继续发消息；
     若旧会话在 Peri 新进程不可用，报错后前端清理，不崩
```

---

## 二、P0-2 Session Inspector（运维可见性）

### 2.1 现状与根因

| 数据 | 现状 | 源码位置 |
|:--|:--|:--|
| 每会话元数据 | `SessionInfo`：peri_id/persona/cwd/title/mode/model/tokens_in/out/total/context_size | lib.rs:653-665 |
| 会话列表 | `load_sessions` 返回数组（无聚合统计） | lib.rs:1397-1410 |
| Agent 状态 | `AgentRuntimeState`：status/last_error/last_connected_at | agent_runtime.rs:25-29 |
| Agent 列表 | `list_agents` 返回 summary | lib.rs:1411（approx） |

**根因**：数据都在内存，但前端没有一站式聚合视图（当前排查问题要在 Sessions/Logs/Status 三个面板拼信息）。缺一个聚合 DTO 命令。

### 2.2 实现方案

#### A. 新命令 `session_inspector`（lib.rs，`load_sessions` 附近）

```rust
#[tauri::command]
async fn session_inspector(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let runtime = state.agent_runtime.lock().map(|v| v.clone()).unwrap_or_default();
    let active_id = state.active_agent.lock().map_err(|e| e.to_string())?.clone();

    let total_tokens: u64 = sessions.values().map(|s| s.tokens_total).sum();
    let total_in: u64 = sessions.values().map(|s| s.tokens_in).sum();
    let total_out: u64 = sessions.values().map(|s| s.tokens_out).sum();
    let active_count = sessions.values()
        .filter(|s| s.has_first_prompt)
        .count();

    let session_rows: Vec<serde_json::Value> = sessions.iter().map(|(source, s)| {
        serde_json::json!({
            "source": source,
            "periId": s.peri_id,
            "title": s.title,
            "model": s.model,
            "mode": s.mode,
            "tokensIn": s.tokens_in,
            "tokensOut": s.tokens_out,
            "tokensTotal": s.tokens_total,
            "contextSize": s.context_size,
            "cwd": s.cwd,
        })
    }).collect();

    Ok(serde_json::json!({
        "agent": {
            "id": active_id,
            "status": runtime.status.as_str(),
            "lastError": runtime.last_error,
            "lastConnectedAt": runtime.last_connected_at,
        },
        "summary": {
            "sessionCount": sessions.len(),
            "activeCount": active_count,
            "tokensTotal": total_tokens,
            "tokensIn": total_in,
            "tokensOut": total_out,
        },
        "sessions": session_rows,
    }))
}
```

> `has_first_prompt` 判 active 是保守近似（发送过首条消息即算活跃）。若需更精确（最近 5 分钟有事件），后续在 SessionInfo 加 `last_activity_at: u64`（dispatcher 更新，lib.rs:568-651 各变体分支顺手写时间戳）——**本期不做**，标注待办。

#### B. 注册命令

lib.rs:1801 `invoke_handler` 列表追加 `session_inspector`（放 `load_sessions` 旁）。

#### C. 前端契约（docs/api-reference.md 同步）

```
session_inspector → {
  agent: { id, status, lastError, lastConnectedAt },
  summary: { sessionCount, activeCount, tokensTotal, tokensIn, tokensOut },
  sessions: [{ source, periId, title, model, mode, tokensIn, tokensOut, tokensTotal, contextSize, cwd }]
}
```

### 2.3 涉及文件与改动量

| 文件 | 改动 | 量 |
|:--|:--|:--|
| `src-tauri/src/lib.rs` | +1 命令 + 注册 | ~45 行 |
| `docs/api-reference.md` | 契约同步 | ~10 行 |

### 2.4 测试/验收路线

```
单测（lib.rs tests 模块）：
  ✅ inspector_aggregates_session_stats：
     构造 fake sessions（2 个，tokens 已知）→ 直接调聚合逻辑（抽成
     fn build_inspector_payload(sessions, runtime, active_id) -> Value）
     → 断言 summary 数字正确

验收（GUI）：
  1. 开 2 个会话，各发消息产生 tokens
  2. 前端调 session_inspector（可先用 devtools console invoke）
  3. 断言：sessionCount=2、tokensTotal 为两者之和、agent.status=connected
```

---

## 三、后续（P2，本期不做，留档）

| 项 | 说明 | 依赖 |
|:--|:--|:--|
| session/fork + resume | Peri fork / Hermes resume 未暴露；官方 schema 类型已备（ForkSessionRequest/ResumeSessionRequest） | 前端入口 |
| MCP 配置持久化 | set_mcp_servers 内存 snapshot（lib.rs:1419），重启丢 | 配置文件方案 |
| Prism route audit（BE-B3-001） | 40 个 Prism 命令输入校验/错误处理审计 | prism.rs |
| Git status（BE-B5-001） | 后端无 Git 模块，前端 Changes/History unavailable | 大功能 |

---

## 四、执行顺序

```
P0-1a agent_runtime 退避常量 + 单测 → cargo check → commit
P0-1b AppState 字段 + manage 初始化 → cargo check → commit
P0-1c replace_agent_client 加 keep_sessions 参数 + 调用点更新（switch/reconnect=false）
       + generation 迁移 + 单测 → cargo check/test → commit
P0-1d 崩溃分支自动重连闭包 + connect_and_replace 拆静态 → cargo check → commit
P0-1e fake ACP 崩溃集成测试 → cargo test → commit
P0-2a session_inspector 命令 + 注册 + 单测 → cargo check/test → commit
P0-2b docs/api-reference.md 契约同步 → commit
```

铁律：一条一 commit、cargo check 通过再 commit、不提前 build、不跳级。
