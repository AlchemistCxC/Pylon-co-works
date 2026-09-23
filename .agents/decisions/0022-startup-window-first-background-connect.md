# ADR-0022 启动窗口先见——默认 agent ACP 连接后台化

- **日期**：2026-09-24
- **状态**：已采用（用户裁定，方案选项见 #270）
- **关联**：#270（实施）、#269（度量基建，基线数据）、ADR-0021 编号顺延

## 背景与约束

`run()` 在 `tauri::Builder::build()`（窗口创建）之前 `block_on` 默认 agent 的 ACP 连接（`lib.rs` 旧 `default_agent_connect_settled` 相位）。#269 实测（真实 Hermes/riccati 配置）：连接 2004ms、窗口 2021ms 才创建——窗口出现时间被 CLI 子进程 spawn+初始化+握手托底，握手超时上限 30s（`DEFAULT_RPC_TIMEOUT_SECS`）。约束：不破坏既有 switch/reconnect 激活语义（generation、session continuity、instance 预算、dispatcher 生命周期）；前端「先快照后监听」防竞态契约保持；失败路径仍可见可重试。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 完全懒连接（首次发消息才连） | UX 语义变化更大：第一条消息前必有连接等待；发送路径需接懒启动，改动面更大 |
| 保留预连接 + splash 兜底 | 窗口仍被连接托底，2s 空屏变成 2s splash；治标不治本 |
| 手动锁 acp 安装后台连接结果 | 绕过 replace_agent_client 的 generation/epoch 校验、dispatcher 重启、实例预算等既有激活机器，重造轮子且易错 |

## 决定

窗口先见 + 后台连接（用户拍板）：

1. `run()` 只创建 runtime 并置 `AgentLifecycleStatus::Connecting`，不再阻塞连接；
2. `run_setup_pipeline` 以 `tokio::spawn` 启动后台初始连接，**复用 `AppState::connect_and_replace`（`do_connect_and_replace` 完整激活机器）**，`start_status=Connecting`、`continuity=Invalidated`、`announce=true`；
3. 后台任务持 `switch_lock` → `agent_lifecycle` 双锁（与 switch/reconnect 同序），串行化竞争窗口；
4. 连接期间**禁止发送**：前端 `send` 命令门控 `connecting` 状态并给明确提示（后端发送失败路径仍为兜底）；左上角三灯经既有 `agentStatusLight` 展示黄灯（connecting → warn，现成映射）；
5. setup 期 dispatcher 启动跳过 Connecting 状态的 runtime（占位 client 上启动监听无意义，激活路径自会启动）。

## 后果

- 正面：窗口出现与 agent CLI 启动速度解耦（实测基线 2021ms → 预期 ~50ms 量级）；失败呈现复用 announce 路径（Disconnected + lastError 别名，红灯 + 手动 reconnect）。
- 负面：启动失败语义微调——旧路径失败置 `Error`，新路径经 `status_after_connection_failure(Connecting)` 回落 `Disconnected`（携带 lastError 别名广播，红灯呈现不变，记录于开发记录）；「打开即可发」变为「连接完成前发送被阻断」（用户裁定接受）。
- 风险：Connecting 窗口期手动 reconnect/switch——由双锁串行化（排队至后台连接完成）；前端快照恰好落在极快失败与监听注册之间的理论窗口——与既有快照机制同一理论洞（亚毫秒级），接受。

## 证据

- 基线：`default_agent_connect_settled=2004ms / windows_created=2021ms`（#270 评论区，#269 基建产出）
- 激活机器复用：`src-tauri/src/lifecycle/mod.rs:87`（do_connect_and_replace）、`src-tauri/src/session/mod.rs:440`（connect_and_replace）、`src-tauri/src/lifecycle/mod.rs:752`（restart_agent_runtime 同构调用）
- 懒启动先例：`src-tauri/src/session/mod.rs:463`（ensure_runtime_ready 将 Connecting 视为进行中，不重复连接）
- 前端现成映射：`src/domains/agent/statusLight.ts:15`（connecting → warn）、`src/components/settings/agentTypes.ts:89`（connecting 为已知状态）
