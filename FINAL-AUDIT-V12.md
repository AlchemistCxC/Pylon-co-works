# Pylon 全面审计报告 — V12 终版（v2）

审计日期: 2026-07-26 | HEAD: 0fdf6e9

---

## 🔴 P0 — 立即修复（6 项）

### R1 — export_session ACP 协议错误
`lib.rs:245-249` 用 snake_case `"agent_message_chunk"` 查 JSON，ACP 协议为 camelCase `"agentMessageChunk"`。且结构错——`content` 跟 `sessionUpdate` 同级，代码多包了一层。**导出功能完全无效。**

### R2 — load_persisted_session tokio task 泄漏
`lib.rs:188-198` tokio::spawn 的 JoinHandle 被 drop，while loop 永不退出。每次点历史会话 → 新增一个后台 task → 内存+CPU 持续累积。

### R3 — session/update 无 sessionId 过滤
`lib.rs:105-114` broadcast 收到全局消息流，emit 时未检查 params 中的 sessionId。多 session 场景下消息会交叉污染。

### R4 — switch_agent 不重连 AcpClient
`lib.rs:165-172` 只改 active_agent 字符串，AcpClient 子进程不变。多 agent 功能实质上不可用。

### R5 — Sidebar 重命名空值无校验
`Sidebar.tsx:108-115` Enter 保存时未校验 renameValue 是否为空 → 会话名可被设为空字符串。

### R6 — /export 查找字段错误
`InputBar.tsx:70` 用 `s.source === sessionId` 查找。sessionId 是 id 字段（如 "slxv2f"），source 是 "local:session-xxx"。永远不匹配，/export 命令无效。

---

## 🔴 新发现 — 历史会话无上下文

**症状**：点历史会话后 ChatView 无历史记录、用户输入不渲染。

**根因**：`Sidebar.tsx handleSelect` 先 `setActiveSession(id)`（React 异步），再立即 `invoke('load_persisted_session')`（同步）。Rust 端 `load_session` 重放历史 → `peri:update` 事件涌来 → 但 ChatView 的 `sessionRef.current` 在 `useEffect` 中更新，尚未执行 → `event.payload.source !== sessionRef.current` 全部丢弃。

```
时序:
  1. setActiveSession(id)       ← React 排队
  2. invoke('load_persisted')   ← 立即执行
  3. Rust spawn task + await load_session
  4. Peri 重放历史 → peri:update 事件到达  ← 此时 sessionRef 还是旧值!
  5. React 重渲染 → useEffect → sessionRef.current = source  ← 太晚了
```

修复：ChatView 不在前端过滤 source，或 load_persisted_session 不依赖 sessionRef。

---

## 🟡 P1 — 性能（5 项）

| # | 位置 | 问题 |
|:--|:--|:--|
| P1 | App.tsx L36 | `useStore()` 无 selector → 全 store 订阅，每次 liveTokensUsed 变重渲染 |
| P2 | InputBar L123/L146 | `useStore.getState().inputMode` 在 render → CLI 切换不更新 DOM |
| P3 | StatusBar L82 | 33fps setInterval → 每秒 33 次重渲染 + wave() 计算 |
| P4 | Sidebar L41-46 | PLATFORM_LABELS + Map + forEach 在 render 体内每帧重建 |
| P5 | Settings L93 | `useStore() as ThemeSettings` 全 store 订阅 |

---

## 🟢 P2 — 清理（15 项）

| # | 内容 |
|:--|:--|
| C1 | MessageBubble.tsx + CSS 死代码（62行） |
| C2 | store presets/activePreset 从未被填充 |
| C3 | PresetRow BUILTIN 缺 'app' key → return null |
| C4 | AcpClient::spawn() 死代码（acp.rs:38-48） |
| C5 | switch_agent 不必要 clone（lib.rs:166） |
| C6 | crate 命名不一致（Cargo.toml pylon vs prism_desktop_lib） |
| C7 | titlebar 引用未定义的 --titlebar-bg CSS 变量 |
| C8 | .cc-blur 从未设置 |
| C9 | ChatView .term-h2/h3/li/p 选择器永不生效（ReactMarkdown 无 className） |
| C10 | StatusBar .ekg-pulse/keyframes 未使用 |
| C11 | appWindow.getCurrentWindow() 每次 render 重建 |
| C12 | ProfileEditor includes() 引用比较 → 重复创建 profile |
| C13 | ChatView toolCallId 可能 undefined → id 冲突 |
| C14 | peri:error payload 为对象 → "[object Object]" |
| C15 | cfg: generate_handler 中 load_sessions 从未被前端调用 |

---

## ✅ 已排除（非 bug）

- **R6（原总报告）** — Sidebar useEffect 无条件覆盖 sessions。实为安全网（store IIFE 解析失败时恢复数据），不算 bug。
- **cacheHit 百分比** — Peri 发的是 cache 命中 token 数，显示为数字即可，非 bug。
