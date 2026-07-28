# Prism Desktop 缺陷清单与修复验收规范

> 文档用途：交给实现 Coder 逐项修复，并作为后续代码审计、Review、验收的唯一问题清单。
>
> 审计角色：当前助手只负责审计、检查证据、复核实现与验证结果，不直接替代 Coder 修改业务代码。
>
> 审计日期：2026-07-27

## 1. 审计边界与协议真值

项目根目录：

```text
G:\Project\prism-desktop
```

ACP 协议只能以以下 Peri 源码为准，不得参考已过时的 `ACP-SPEC.md`：

```text
F:\A-I\Agent\Peri\peri-tui\src\acp_stdio\
F:\A-I\Agent\Peri\peri-tui\src\acp_server\
F:\A-I\Agent\Peri\acp-hub\
```

已确认的协议事实：

1. `initialize` 参数使用 `clientCapabilities`。
2. `session/set_mode` 参数使用 `modeId`。
3. `session/new` 返回完整对象，包含 `sessionId`、`modes`、`configOptions`。
4. `session/load` 在 response 之前通过 `session/update` 重放历史。
5. notification 事件变体使用 snake_case：
   - `user_message_chunk`
   - `agent_message_chunk`
   - `agent_thought_chunk`
   - `tool_call`
   - `tool_call_update`
   - `usage_update`
   - `available_commands_update`
   - `config_option_update`
   - `session_info_update`
6. `session/cancel` 是 notification；`session/close` 是 request。
7. stdio 的 `session/set_config_option.value` 使用 tagged `ValueId` 结构。
8. Pylon 存在三层不同的会话标识，禁止混用：
   - `Session.id`：前端 Zustand 本地 ID。
   - `Session.source`：Pylon Rust `sessions` map key，也是 Tauri command 的 `source`。
   - `periId`：Peri ACP 的 `sessionId`。

## 2. Coder 工作规则

1. 每个独立根因单独修复、单独提交，不得把无关重构混进 Bug Fix。
2. 修复前必须完整阅读目标文件和上下游调用链。
3. 后端 ACP 改动必须直接对照 Peri 源码，不准依据旧文档猜字段。
4. 不得通过延长 timeout、增加固定 sleep、吞掉异常等方式掩盖竞态。
5. 不得仅修改 UI 显示而不修复数据源或生命周期根因。
6. 不得把 per-session 状态继续存成单一全局字段。
7. 每个提交必须附带：
   - 修复的问题编号。
   - 根因说明。
   - 变更文件。
   - 实际执行的验证命令和输出摘要。
8. 前端提交至少执行：

```text
npm run build
```

9. Rust 后端提交至少执行：

```text
unset RUSTFLAGS; cargo check
```

10. 涉及 `acp-hub` 时额外执行：

```text
cargo check -p acp-hub
```

11. 禁止改动或恢复用户当前已有的 Markdown 删除状态：

```text
ACP-SPEC.md
docs/COWORK.md
docs/FOR-YUESHANG.md
docs/api-reference.md
```

---

# 3. P0：必须优先修复

## BUG-P0-01：Prompt 超时后 Peri 仍继续执行

### Bug 点

Pylon 等待 `session/prompt` 超时后只删除本地 pending request，没有向 Peri 发送 `session/cancel`。旧任务仍会执行、发送 notification 并最终写回 history。

Peri stdio 路径会为每个 prompt 启动独立任务，但没有 `acp_server` 路径中的 per-session `prompt_lock`。用户在超时后重试时，两个 prompt 可能基于同一份旧 history 并发运行，后完成者整体覆盖 history。

### 参考代码

```text
G:\Project\prism-desktop\src-tauri\src\lib.rs:257-278
G:\Project\prism-desktop\src-tauri\src\acp.rs:138-160
F:\A-I\Agent\Peri\peri-tui\src\acp_stdio\session\prompt.rs:55-75
F:\A-I\Agent\Peri\peri-tui\src\acp_stdio\session\prompt.rs:107-129
F:\A-I\Agent\Peri\peri-tui\src\acp_stdio\session\prompt_exec.rs:174-180
F:\A-I\Agent\Peri\peri-tui\src\acp_server\mod.rs:96-99
F:\A-I\Agent\Peri\peri-tui\src\acp_server\mod.rs:144-155
```

### 修复方法

1. Pylon timeout 分支必须向对应 `periId` 发送 `session/cancel`。
2. timeout 后不能仅删除 pending 并假定执行已经停止；需要明确等待或处理取消后的最终 prompt response。
3. 为同一 `source/periId` 建立 per-session prompt serialization，禁止同一 Peri session 同时运行两个 prompt。
4. 不得继续用全局锁替代 per-session 锁。
5. 取消后到达的迟发 notification 必须带 generation/request identity，或被明确归档到原 turn，不能混入重试后的新 turn。

### 验收标准

- 构造超过 timeout 的 prompt 后，日志能证明 Pylon 发出了 `session/cancel`。
- 超时后立即重试，同一 `periId` 不存在两个并发 prompt。
- 旧 prompt 的 chunk/tool/done 不会混入新 prompt。
- history 不发生丢失、乱序或后完成任务覆盖新状态。

---

## BUG-P0-02：会话切换会把 A 的消息写入 B 的 localStorage

### Bug 点

React 会话切换 effect 调用 `setMessages()` 后，持久化 effect 可能在下一轮 state 生效前，以“新 sessionId + 旧 messages”写入缓存。

### 参考代码

```text
G:\Project\prism-desktop\src\components\chat\ChatView.tsx:104-150
G:\Project\prism-desktop\src\components\chat\ChatView.tsx:306-310
```

### 修复方法

推荐将消息存储改成按 session key 分区：

```ts
Record<SessionId, Message[]>
```

持久化时必须使用消息自身所属的 session ID，而不是当前 render 的 `sessionId`。如果暂时不重构消息仓库，至少增加当前消息 owner ref/generation guard，只有 owner 与目标 session 一致时才允许持久化。

禁止用 `setTimeout`、延迟 effect 或清空后等待一帧规避。

### 验收标准

1. A、B 各自存在不同消息。
2. 连续执行 A→B→A→B 切换。
3. 检查 `pylon-msgs-A` 和 `pylon-msgs-B`，两者内容始终隔离。
4. 重启应用后两边历史仍正确。

---

## BUG-P0-03：后台会话的流式事件被永久丢弃

### Bug 点

ChatView 只有一套全局 Tauri listener，收到事件后先与当前 `sessionRef.current` 比较。非当前会话的 chunk、tool、done、error 全部直接丢弃。

### 参考代码

```text
G:\Project\prism-desktop\src\components\chat\ChatView.tsx:102-111
G:\Project\prism-desktop\src\components\chat\ChatView.tsx:152-302
```

### 修复方法

1. 将 Tauri event ingestion 从当前 ChatView 展示组件中拆出，放到应用级 session event store/controller。
2. 所有事件先按 `payload.source` 路由到对应会话消息仓库。
3. ChatView 只订阅当前会话的已存状态，不负责决定其他会话事件是否接收。
4. `done/error` 必须按 source 清理对应会话的 generating 状态。
5. `sessionId = null` 时必须明确清理当前 view ref，不得继续接受旧 source 为当前视图事件。

### 验收标准

- A 正在生成时切到 B，A 能在后台完整接收文本、reasoning、tool、done/error。
- 切回 A 后能看到完整结果。
- A 的生成状态被正确结束，不污染 B。

---

## BUG-P0-04：session/load replay 与 localStorage 恢复重复，并卡住生成态

### Bug 点

ChatView 先从 localStorage 恢复消息，再调用 `session/load`。Peri 会在 response 前 replay 全部历史。Replay 的 `user_message_chunk` 又被 Pylon 转为 `peri:user`，前端把它当成新 prompt 开始，设置 `generating=true`，但 load 路径没有对应 `peri:done`。

### 参考代码

```text
G:\Project\prism-desktop\src\components\chat\ChatView.tsx:113-150
G:\Project\prism-desktop\src\components\chat\ChatView.tsx:154-173
G:\Project\prism-desktop\src\components\chat\ChatView.tsx:270-278
G:\Project\prism-desktop\src-tauri\src\lib.rs:418-431
F:\A-I\Agent\Peri\peri-tui\src\acp_stdio\session\create.rs:146-192
```

### 修复方法

1. 明确历史唯一真值：Peri replay 或本地缓存只能有一个主来源。
2. 如果保留 localStorage 作为离线 fallback，必须给 replay 增加 replay phase 标识并去重，不得把 replay user message 当成新生成开始。
3. `load_persisted_session` 应将 Peri response 中的 `modes/configOptions` 返回前端，不应只返回 `()`。
4. Replay 完成应由 `session/load` response 作为确定性边界，不得依赖固定 sleep。
5. 恢复过程必须有独立 loading/replaying 状态，不能复用 live generating。

### 验收标准

- 恢复历史不会重复。
- 恢复后 spinner 不会永久存在。
- `liveGenerating` 保持 null。
- mode、model、commands 等会话配置能正确恢复。

---

# 4. P1：核心功能修复

## BUG-P1-01：空 Session Prompt 覆盖 Profile persona

### Bug 点

前端始终发送 `sessionPrompt: ''`。Rust 收到的是 `Some("")`，`unwrap_or(persona)` 不会回退到 persona。

### 参考代码

```text
G:\Project\prism-desktop\src\components\chat\InputBar.tsx:121-125
G:\Project\prism-desktop\src\components\SessionSettings.tsx:73-76
G:\Project\prism-desktop\src-tauri\src\lib.rs:238-244
```

### 修复方法

后端以 trim 后非空为准：

```rust
let effective_persona = session_prompt
    .filter(|value| !value.trim().is_empty())
    .unwrap_or(persona);
```

前端也可将空白值转为 `undefined/null`，但后端仍需防御空字符串。

### 验收标准

- Session Prompt 留空时，首条消息注入 Profile persona。
- Session Prompt 非空时覆盖 Profile persona。
- 只包含空格的 Session Prompt 视为空。

---

## BUG-P1-02：首次 prompt 标记在发送成功前提交

### Bug 点

`has_first_prompt` 在 ACP 写入和 response 前被设置为 true。写入失败、Agent 崩溃、RPC error、timeout 后都不回滚，用户重试时 persona 不再注入。

### 参考代码

```text
G:\Project\prism-desktop\src-tauri\src\lib.rs:207-214
G:\Project\prism-desktop\src-tauri\src\lib.rs:248-278
```

### 修复方法

把首轮状态建模为明确状态机，例如：

```text
PendingFirstPrompt → InFlightFirstPrompt → Committed
                               ↘ Failed/Cancelled → PendingFirstPrompt
```

只有 prompt 成功提交并获得有效 response 后才进入 committed；所有失败和取消路径回滚。

### 验收标准

首条消息分别模拟 stdin 关闭、RPC error、timeout，重试时 persona 仍会注入。

---

## BUG-P1-03：全局 session_creation 锁覆盖整个 prompt 生命周期

### Bug 点

`send_message` 持有全局 `session_creation` 锁直到 prompt 最终响应，导致其他 session 发送、新建 session、切换 Agent、重连 Agent 最长阻塞 300 秒。

### 参考代码

```text
G:\Project\prism-desktop\src-tauri\src\lib.rs:172
G:\Project\prism-desktop\src-tauri\src\lib.rs:206-280
G:\Project\prism-desktop\src-tauri\src\lib.rs:335
G:\Project\prism-desktop\src-tauri\src\lib.rs:354
```

### 修复方法

1. 将 Agent lifecycle lock 与 session prompt lock 分开。
2. lifecycle lock 只覆盖 ACP client generation 替换、session 创建映射提交等短临界区。
3. prompt 等待不能持有全局 lifecycle lock。
4. 同一 session 使用 per-session lock；不同 session 允许并行。
5. 所有操作应校验自己使用的 ACP client generation 是否仍有效。

### 验收标准

- A 生成时 B 可以发送消息。
- A 生成时可以创建 C。
- 同一 session 的两个 prompt 串行。
- 不同 session 的 prompt 可以并发。

---

## BUG-P1-04：Agent 切换先杀旧进程，连接新 Agent 失败后系统瘫痪

### 参考代码

```text
G:\Project\prism-desktop\src-tauri\src\lib.rs:334-349
G:\Project\prism-desktop\src-tauri\src\lib.rs:353-366
```

### 修复方法

实现两阶段切换：

1. 在不破坏旧 client 的情况下创建并 initialize 新 client。
2. 新 client 完全可用后，在短临界区原子替换 active client/generation。
3. 替换成功后再停止旧进程并清理旧 session。
4. 新连接失败时保持旧 Agent、activeAgent 和 sessions 不变。
5. UI 显示切换错误，不得静默吞掉。

### 验收标准

将目标 Agent exe 改成无效路径并尝试切换，旧 Agent 仍可继续处理消息，UI 仍显示旧 Agent，并展示失败原因。

---

## BUG-P1-05：AcpClient initialize 失败遗留孤儿子进程

### 参考代码

```text
G:\Project\prism-desktop\src-tauri\src\acp.rs:210-247
G:\Project\prism-desktop\src-tauri\src\acp.rs:299-315
```

### 修复方法

1. `connect` 过程中 initialize 失败时显式 kill + wait 子进程。
2. 为 child lifecycle 建立 RAII guard；仅在连接成功提交后解除 guard。
3. 评估实现 `Drop`，但不得在 async context 中用阻塞方式制造死锁。
4. writer/reader 线程应随 pipe 关闭退出。

### 验收标准

连续制造 5 次 initialize 失败，进程列表中不存在累积的 Agent 子进程。

---

## BUG-P1-06：load_persisted_session 与 Agent 切换存在竞态

### 参考代码

```text
G:\Project\prism-desktop\src-tauri\src\lib.rs:418-431
G:\Project\prism-desktop\src-tauri\src\lib.rs:334-364
```

### 修复方法

1. 为 ACP client 增加 generation ID。
2. load 开始时捕获 generation；response/replay 提交时验证 generation 未变化。
3. load 与 switch/reconnect 的关键映射提交必须经过统一 lifecycle 协调。
4. generation 变化时 load 明确返回 cancelled/stale error，并移除临时 source 映射。

### 验收标准

并发执行 load 与 switch/reconnect，不得出现“load 返回成功但随后 session not found”。

---

## BUG-P1-07：`/model` 命令没有切换当前 Peri session

### 参考代码

```text
G:\Project\prism-desktop\src\components\chat\InputBar.tsx:73-80
G:\Project\prism-desktop\src\components\chat\ModelWidget.tsx:29-37
```

### 修复方法

提取统一的 session model setter，命令和 ModelWidget 共用同一路径：

```text
Session.id → Session.source → invoke(set_config_option) → response/config update → sessionConfig[source]
```

失败时保留原值并向用户显示错误。

### 验收标准

输入 `/model X` 后抓取 ACP 请求，确认发送：

```json
{
  "method": "session/set_config_option",
  "params": {
    "sessionId": "<periId>",
    "configId": "model",
    "value": {"valueId": {"value": "X"}}
  }
}
```

---

## BUG-P1-08：附件只发送文件名，不发送内容

### 参考代码

```text
G:\Project\prism-desktop\src\components\chat\InputBar.tsx:137-145
G:\Project\prism-desktop\src-tauri\src\lib.rs:232-244
F:\A-I\Agent\Peri\peri-tui\src\acp_stdio\session\prompt.rs:31-52
```

### 修复方法

1. 根据 ACP ContentBlock 能力发送真正内容。
2. 文本文件可读取为 text/resource block；图片按 mime type 转成 image base64 block。
3. 必须设置文件大小上限、类型白名单、读取错误提示。
4. 路径仅来自 Tauri dialog 结果，不信任任意前端字符串。
5. 不支持的类型必须明确提示，不得显示为已成功附加。

### 验收标准

附加文本文件后 Agent 能逐字读取内容；附加图片后 Peri 收到 image block；读取失败时输入与附件不丢失。

---

## BUG-P1-09：Peri 业务失败被当成成功

### Bug 点

Peri ThreadStore 创建失败时可能返回 `sessionId = "error"`；未知 session 的 prompt 可能返回 `EndTurn`。Pylon 当前只检查 JSON-RPC error。

### 参考代码

```text
F:\A-I\Agent\Peri\peri-tui\src\acp_stdio\session\create.rs:32-39
F:\A-I\Agent\Peri\peri-tui\src\acp_stdio\session\prompt.rs:55-73
G:\Project\prism-desktop\src-tauri\src\acp.rs:119-125
G:\Project\prism-desktop\src-tauri\src\lib.rs:178-188
G:\Project\prism-desktop\src-tauri\src\lib.rs:259-270
```

### 修复方法

1. Pylon 拒绝空 sessionId 和 sentinel `"error"`。
2. Prompt response 必须解析 `stopReason`，不能把所有非 JSON-RPC-error response 都视为正常完成。
3. 对无任何输出、session 映射异常的 `EndTurn` 给出明确错误。
4. 如允许修改 Peri，优先让 Peri 返回标准 JSON-RPC error，而不是成功 sentinel。

### 验收标准

模拟 ThreadStore 创建失败和未知 session prompt，前端收到明确 error，不建立伪 session，不显示正常完成。

---

## BUG-P1-10：Profile 集合不持久化，activeProfileId 会悬空

### 参考代码

```text
G:\Project\prism-desktop\src\store.ts:121-144
G:\Project\prism-desktop\src\store.ts:233-235
G:\Project\prism-desktop\src\components\ProfileEditor.tsx:26-37
```

### 修复方法

1. `profiles` 与 `activeProfileId` 必须使用同一持久化策略。
2. 添加 schema version 和 migration，避免旧数据破坏。
3. hydrate 后验证 active ID 是否存在；不存在则回退到有效默认 Profile。
4. Session 发送 persona 时以 `session.profileId` 对应 Profile 为准，而不是当前全局 activeProfileId。

### 验收标准

编辑、新增 Profile 后重启，Profile 与 active ID 均正确；删除/损坏数据时能回退到有效 Profile。

---

# 5. P2：体验与可靠性问题

## BUG-P2-01：消息发送失败后仍清空输入和附件

参考：

```text
G:\Project\prism-desktop\src\components\chat\InputBar.tsx:110-130
```

修复：只在 `invoke('send_message')` 成功后清空；失败时保留输入和附件，显示可重试错误。

验收：断开 Agent 后发送，文本和附件仍在。

---

## BUG-P2-02：Mode 是全局状态，失败不回滚

参考：

```text
G:\Project\prism-desktop\src\components\chat\ModeWidget.tsx:14-23
G:\Project\prism-desktop\src\components\chat\InputBar.tsx:81-86
G:\Project\prism-desktop\src\store.ts:67-71
```

修复：mode 按 `source` 存储；读取 Peri config/modes 真值；失败回滚并显示错误。

---

## BUG-P2-03：Tool Call 的 `failed` 状态被显示为成功

参考：

```text
G:\Project\prism-desktop\src\components\chat\ChatView.tsx:224-233
G:\Project\prism-desktop\src\components\chat\ChatView.tsx:464-477
F:\A-I\Agent\Peri\peri-tui\src\kit\acp_notifier.rs:459-478
```

修复：按 ACP 枚举处理 `pending/in_progress/completed/failed`，不得只识别字符串 `error`。

---

## BUG-P2-04：Cache hit token 被显示成百分比

参考：

```text
G:\Project\prism-desktop\src\components\chat\ChatView.tsx:236-244
G:\Project\prism-desktop\src\components\ControlCenter.tsx:72-81
```

修复：要么显示 `cacheReadTokens` 的 token 数，要么用明确分母计算比例；字段命名区分 count 与 rate。

---

## BUG-P2-05：导出会话静默截断且内容不完整

参考：

```text
G:\Project\prism-desktop\src-tauri\src\acp.rs:28-31
G:\Project\prism-desktop\src-tauri\src\lib.rs:443-489
F:\A-I\Agent\Peri\peri-tui\src\acp_stdio\session\create.rs:149-192
```

修复：利用 `session/load` response 作为 replay 完成边界；正确处理 `RecvError::Lagged`；优先直接从 ThreadStore/结构化 replay 生成导出；包含 user、assistant、reasoning、tool 和 metadata；禁止固定 1500ms sleep。

---

## BUG-P2-06：Session Settings 的 Skills/Hooks 只保存，不生效

参考：

```text
G:\Project\prism-desktop\src\components\SessionSettings.tsx:79-103
G:\Project\prism-desktop\src\components\chat\InputBar.tsx:121-125
G:\Project\prism-desktop\src-tauri\src\lib.rs:192-200
```

修复：在未建立真实运行时链路前，移除或明确标为“未接入”；若保留则必须定义它们如何进入 Peri session/frozen context，不能只存 localStorage。

---

## BUG-P2-07：Profile 切换后 activeSession 与 persona 错配

参考：

```text
G:\Project\prism-desktop\src\App.tsx:18
G:\Project\prism-desktop\src\components\Sidebar.tsx:121-125
G:\Project\prism-desktop\src\components\chat\InputBar.tsx:26-39
```

修复：发送 persona 使用 session.profileId；切 Profile 时明确切换到该 Profile 的会话或清空 activeSession。

---

## BUG-P2-08：close_session 远端失败后无法重试

参考：

```text
G:\Project\prism-desktop\src-tauri\src\lib.rs:297-304
```

修复：远端 close 成功后再提交本地删除，或保存 pending-close 重试信息；不得先丢失 `source → periId` 映射。

---

## BUG-P2-09：启动 Agent 失败导致应用直接 panic

参考：

```text
G:\Project\prism-desktop\src-tauri\src\agent_config.rs:24-36
G:\Project\prism-desktop\src-tauri\src\lib.rs:495-503
```

修复：应用应先启动 UI，再把 Agent 连接状态暴露为 connected/error/reconnecting；配置和连接错误必须进入可恢复错误页，不使用 `expect` 终止整个应用。

---

## BUG-P2-10：消息显示设置未进入渲染链

字段：

```text
msgStyle
msgFont
msgTextColor
msgLineHeight
```

参考：

```text
G:\Project\prism-desktop\src\components\Settings.tsx:312-320
G:\Project\prism-desktop\src\components\chat\ChatView.tsx:321-380
G:\Project\prism-desktop\src\components\chat\ChatView.css:8-102
```

修复：要么接入当前 terminal renderer 和 CSS variables，要么删除无效设置及死字段，不保留伪配置。

---

## BUG-P2-11：EKG barHeight 和 numeric 模式无效

参考：

```text
G:\Project\prism-desktop\src\components\ControlCenter.tsx:21-47
G:\Project\prism-desktop\src\components\ControlCenter.tsx:457-497
G:\Project\prism-desktop\src\components\chat\StatusBar.css
```

修复：`barHeight` 注入 `--bar-h`；numeric 分支渲染纯数值，不得复用 bar；统一 `tokenDisplay` 与 `ccStyle` 的职责，删除冲突状态。

---

## BUG-P2-12：RightPanel 透明度与模糊变量未使用

参考：

```text
G:\Project\prism-desktop\src\App.tsx:123-127
G:\Project\prism-desktop\src\components\RightPanel.css
G:\Project\prism-desktop\src\components\Settings.tsx:363-375
```

修复：在 `.right-panel` 消费 `--right-transparency`、`--right-blur`，并确认背景层与内容层的透明度语义不会导致文字一起变淡。

---

## BUG-P2-13：暗色模式命令面板白底白字

参考：

```text
G:\Project\prism-desktop\src\components\chat\InputBar.css:12-16
G:\Project\prism-desktop\src\index.css:28-40
```

修复：命令面板背景、边框、文字全部使用 theme token，并增加 dark scheme 实测。

---

## BUG-P2-14：PrismSheet 与 RightPanel 展示静态 mock 为真实功能

参考：

```text
G:\Project\prism-desktop\src\components\PrismSheet.tsx
G:\Project\prism-desktop\src\components\RightPanel.tsx
```

修复选择其一：

1. 接入真实 API 和保存动作；或
2. 在正式产品中隐藏；或
3. 明确标注“演示/未接入”，禁用按钮。

严禁固定 Debug 结果冒充真实测试结果。

---

# 6. P3：代码质量与可维护性

## BUG-P3-01：重复持久化体系

参考：

```text
G:\Project\prism-desktop\src\store.ts
G:\Project\prism-desktop\src\components\Sidebar.tsx
G:\Project\prism-desktop\src\components\SessionSettings.tsx
G:\Project\prism-desktop\src\components\chat\ChatView.tsx
```

Zustand persist 与手写 `pylon-sessions`、`pylon-msgs-*` 同时存在。应定义单一数据所有者、schema version 和 migration。

---

## BUG-P3-02：错误被静默吞掉

搜索目标：

```text
.catch(() => {})
catch {}
```

修复：用户可操作错误进入 UI；诊断错误进入结构化日志；乐观更新必须回滚。仅允许明确说明理由的 best-effort cleanup 吞错。

---

## BUG-P3-03：`reload_agents` 不能重新读取 agents.yaml

参考：

```text
G:\Project\prism-desktop\src-tauri\src\agent_config.rs:24-28
G:\Project\prism-desktop\src-tauri\src\lib.rs:376-381
```

`include_str!` 是编译期嵌入。修复：要么运行时读取明确配置路径，要么删除/重命名伪 reload command。

---

## BUG-P3-04：agents.yaml 不可移植

参考：

```text
G:\Project\prism-desktop\agents.yaml
```

绝对路径和 `cwd: .` 会随机器、启动方式漂移。修复时使用显式可配置路径和清楚的相对路径基准，不引入隐式魔法路径。

---

## BUG-P3-05：大量 any 绕过 ACP 类型检查

参考：

```text
G:\Project\prism-desktop\src\components\chat\ChatView.tsx
G:\Project\prism-desktop\src\components\ControlCenter.tsx
G:\Project\prism-desktop\src\components\Settings.tsx
```

修复：为 Tauri command response、`peri:update` payload、config options、session update variants 建立 discriminated unions。禁止通过扩大 `any` 完成修复。

---

## BUG-P3-06：无障碍交互问题

参考：

```text
G:\Project\prism-desktop\src\components\Settings.tsx:55-64
G:\Project\prism-desktop\src\components\Settings.tsx:145-150
G:\Project\prism-desktop\src\components\ColorPopover.tsx:19-41
G:\Project\prism-desktop\src\components\Sidebar.css:45-48
```

修复：交互 div 改为 button 或补齐键盘/ARIA 语义；侧栏按钮增加 `:focus-visible`/`:focus-within` 显示。

---

## BUG-P3-07：生产 bundle 过大

已实测：

```text
index-CXR3UsCK.js 约 9,046.59 kB，gzip 约 1,872.79 kB
```

主要参考：

```text
G:\Project\prism-desktop\src\components\chat\ChatView.tsx:390-405
```

修复：按需加载语言 grammar、缓存 starry-night 实例、避免每个 CodeBlock 重建完整 common grammar；提交需给出新旧真实构建体积对比。

---

# 7. 审计 Review 清单

Coder 提交后，审计必须逐项检查：

## 7.1 规格符合性

- [ ] 修复对应明确 BUG 编号。
- [ ] 修改解决根因，不是隐藏症状。
- [ ] 未夹带无关重构或视觉改版。
- [ ] 未参考/恢复过时 `ACP-SPEC.md`。
- [ ] 三层 ID 没有混用。
- [ ] per-session 状态没有继续写入全局单值。

## 7.2 并发与生命周期

- [ ] 同 session prompt 串行，不同 session 可并行。
- [ ] timeout/cancel/switch/reconnect 每条失败路径都有状态收敛。
- [ ] Agent 切换失败不破坏旧 Agent。
- [ ] 子进程不存在失败出口泄漏。
- [ ] stale generation 的 response/notification 不会提交。

## 7.3 React 与持久化

- [ ] 会话切换不会串写消息。
- [ ] 后台会话事件不会丢失。
- [ ] Effect cleanup 完整。
- [ ] localStorage/Zustand 只有清晰的单一所有权。
- [ ] 失败不会清空用户未发送成功的输入。

## 7.4 ACP 数据结构

- [ ] `clientCapabilities` 正确。
- [ ] `modeId` 正确。
- [ ] config option ValueId 正确。
- [ ] snake_case update variants 正确。
- [ ] replay 与 live event 被区分。
- [ ] `failed` tool status 正确显示。

## 7.5 安全和错误处理

- [ ] 不新增未经清洗的 `dangerouslySetInnerHTML`。
- [ ] 文件附件有大小、类型和路径边界。
- [ ] 不新增 `.catch(() => {})` 隐藏关键错误。
- [ ] 不硬编码密钥或隐私数据。

## 7.6 验证证据

- [ ] `npm run build` exit 0。
- [ ] `unset RUSTFLAGS; cargo check` exit 0。
- [ ] 涉及 hub 时 `cargo check -p acp-hub` exit 0。
- [ ] 新增或更新针对根因的自动化测试。
- [ ] Git diff 只包含声明范围内文件。
- [ ] 用户原有 Markdown 删除状态未被触碰。

# 8. 提交建议顺序

建议按以下顺序交付，每项单独 commit：

1. `BUG-P0-01`：timeout cancel + per-session prompt serialization。
2. `BUG-P0-02`、`BUG-P0-03`：按 session 分区的消息仓库与事件路由。
3. `BUG-P0-04`：replay 恢复状态机与历史单一真值。
4. `BUG-P1-01`、`BUG-P1-02`：persona 与首轮事务。
5. `BUG-P1-03`：缩小全局锁，建立 Agent generation/lifecycle 模型。
6. `BUG-P1-04`、`BUG-P1-05`、`BUG-P1-06`：Agent 原子切换、子进程清理、load 竞态。
7. `BUG-P1-07`、`BUG-P1-08`、`BUG-P1-09`：model、附件、业务错误语义。
8. `BUG-P1-10`：Profile 持久化与 session.profileId 真值。
9. P2 体验问题。
10. P3 代码质量与性能问题。

未经审计确认，不建议一次性合并多个 P0/P1 根因。
