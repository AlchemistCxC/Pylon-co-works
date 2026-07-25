# Pylon Backend Audit & Plan V3

> 审阅日期：2026-07-26
> 审阅范围：`src-tauri/src/` 全部 5 文件，845 行 + Peri 源码查证
> Peri 查证位置：`peri-tui/src/acp_stdio/`、`peri-acp/src/`、`peri-acp-types/src/peri_caps.rs`

---

## 一、P0 — 协议级缺陷（Peri 源码查证发现）

### P0-1 `set_config_option` 格式错误

**位置**：`acp.rs:112-118` / `lib.rs:196-219`

**Peri 期望格式**（`config.rs:39-40`）：
```json
{"sessionId":"...", "configId":"model", "value": {"valueId": {"value": "opus"}}}
```

**Pylon 当前发送**：
```json
// ❌ 字段名错：key→configId，值类型错：string→{valueId:{value:string}}
{"sessionId":"...", "key":"model", "value":"opus"}
```

**后果**：`set_config_option` 协议完全不匹配，Peri 收到后因无法解析 `value` 字段而跳入 `config.rs:83-85` 的 `_ => debug!("Unknown config option value type")` 分支，静默失败。**前端切 model 永远不生效。**

**修复**：
```rust
// acp.rs set_config_option 方法改为
self.call_async(METHOD_SESSION_SET_CONFIG_OPTION, serde_json::json!({
    "sessionId": session_id,
    "configId": key,
    "value": {"valueId": {"value": value}}
})).await
```
并删除 `lib.rs` 的 pre-subscribe 通知收集——Peri 在 response body 里直接返回完整 `configOptions`（`config.rs:88`），不需要等 notification。

### P0-2 `initialize` capabilities 缺少 `_meta`

**位置**：`acp.rs:278-281`

**Peri 读取方式**（`transport.rs:23-28`、`peri_caps.rs:44-59`）：从 `clientCapabilities._meta` 中以 `peri.xxx` 键名解析。

**Pylon 当前发送**：
```json
{"capabilities": {"tokenStats": true}}
```

**Peri 实际需要的格式**：
```json
{
  "capabilities": {
    "tokenStats": true,
    "_meta": {
      "peri.tokenStats": true,
      "peri.skillNames": true,
      "peri.replay": true
    }
  }
}
```

**后果**：
- `tokenStats` 在标准 ACP 层被处理（侥幸生效）——`usageUpdate._meta` 正常发送 ✅
- `skillNames` 未声明 → `availableCommandsUpdate._meta.skillNames` 不发送 ❌
- `replay` 未声明 → `session/load` 重放时不标记 `_peri.replay` ❌

**修复**：initialize 的 capabilities 加 `_meta` 字段，声明 `peri.skillNames` 和 `peri.replay`。

### P0-3 `set_config_option` 支持 `thinking_effort` 和 `context_1m`

**查证**：Peri `config.rs:42-77` 支持 5 个 config key。

| key | 值示例 | 说明 |
|:--|:--|:--|
| `mode` | `default`/`accept_edit`/`auto`/`bypass` | 同 `set_mode` |
| `model` | `opus`/`sonnet`/`haiku` | 切换 LLM |
| `thinking_effort` | `low`/`medium`/`high`/`xhigh`/`max` | 思考深度 |
| `context_1m` | `true`/`1`/`false`/`0` | 1M 上下文开关 |

**当前状态**：Pylon 的 `set_config_option` command 接受任意 `key`/`value`，透传到 Peri。修复 P0-1 后这四个 key 自动生效。无需额外代码。

---

## 二、审阅发现（Pylon 自身代码）

### A. 逻辑缺陷（3 项）

| ID | 位置 | 问题 | 严重度 |
|:--|:--|:--|:--|
| **A1** | `acp.rs:86` | `call_async` 无超时——`new_session`/`close_session`/`set_mode` 等非 prompt RPC 若子进程 hang 住，调用方永久阻塞 | 中 |
| **A2** | `acp.rs:267` | `crashed` 在 stdout 关闭时无条件置 true——包括 `kill()` 主动杀死。`switch_agent` 后短暂误报 | 低 |
| **A3** | `lib.rs:389` | 默认 agent 硬编码 `"peri"`——与 `agents.yaml` key 不同步则启动 panic | 低 |

### B. 重复代码（3 项）

| ID | 位置 | 问题 |
|:--|:--|:--|
| **B1** | `lib.rs:144-164` vs `307-320` vs `348-358` | 通知转发 loop 出现 3 次。每次 copy 都有细微差异（userMessageChunk 只在 send_message 有） |
| **B2** | `lib.rs:88-103` | `'session:` 标签 block 内联"查缓存→未命中则创建" |
| **B3** | 全局 | `get_active_agent()` clone 整个 `AgentDef` 但只用 `cwd` 或 `name` |

### C. 类型债务（3 项）

| ID | 位置 | 问题 |
|:--|:--|:--|
| **C1** | `error.rs` | `PylonError` 9 变体 + 4 `From` impl，但只有 `AgentCrashed` 被用过一次 |
| **C2** | `error.rs` | 缺 `impl From<PylonError> for tauri::ipc::InvokeError` |
| **C3** | `lib.rs:239` | `load_sessions` 返回内存活跃会话，名字误导 |

### D. 硬编码/缺失（3 项）

| ID | 位置 | 问题 |
|:--|:--|:--|
| **D1** | `acp.rs:280` | `clientInfo.name` 写死 `"prism-desktop"` — 应为 `"Pylon"` |
| **D2** | `acp.rs:49-50` | `agent_name` / `agent_cwd` 字段写入后从未读取 — dead code |
| **D3** | `agent_config.rs` | `AgentDef` 无 `default: bool`，无法标记首选 agent |

### E. 架构（2 项）

| ID | 位置 | 问题 |
|:--|:--|:--|
| **E1** | `lib.rs:120-121` | `send_message` 两次 `lock().await`，`resubscribe()` 和 `send_prompt_atomic()` 间有理论时间窗 |
| **E2** | `lib.rs:13-18` | `agents` 是普通 `HashMap`，无法热加载 |

---

## 三、优先级排序

| 优先级 | 条目 | 行数 | 理由 |
|:--|:--|:--|:--|
| **P0-1** | P0-1 `set_config_option` 协议修正 | 10 | 功能完全不可用，必须立刻修 |
| **P0-2** | P0-2 `initialize` 加 `_meta` 声明 Peri caps | 8 | 技能列表、重放标记全部缺失 |
| **P0-3** | P0-1 尾部：删除 pre-subscribe 改用 response body | −10 | 协议修正后 notification 收集变多余，反而简化 |
| **P1-1** | D2 删 dead code | 5 | 零风险消除 warning |
| **P1-2** | D1 改名 `"Pylon"` | 1 | 一个字符串 |
| **P1-3** | C1+C2 PylonError 贯通 + InvokeError | 30 | 类型安全基础 |
| **P1-4** | D3 default agent | 10 | 消除硬编码 |
| **P1-5** | B1 合并通知转发 | 25 | 消灭 3 份重复 |
| **P2-1** | A1 call_async 超时 | 15 | 防无限阻塞 |
| **P2-2** | B2 send_message 重构 | 20 | 消除标签 block |
| **P2-3** | A2 crashed 语义 | 10 | 精确化 |
| **P3-1** | E1 合并锁 | 10 | 消除理论竞态 |
| **P3-2** | C3 重命名 | 5 | `load_sessions` → `active_sessions` |
| **P3-3** | B3 减少 clone | 10 | 微优化 |

**P0 总计**：~8 行（净删 2 行）
**P1 总计**：~71 行，5 个 commit
**P2 总计**：~45 行，3 个 commit
**P3 总计**：~25 行，3 个 commit

---

## 四、不做的事项

- 模块拆分（437 行未到阈值）
- `SessionInfo` 加字段（前端未用）
- ContentBlock image（前端无图片输入）
- session/fork, session/resume（低频）
- E2 热加载（重启够用）
