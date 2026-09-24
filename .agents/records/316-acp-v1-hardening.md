# Dev Record — #316 ACP v1 协议面补强（修错组 + fs/terminal 通电 + elicitation form + SDK 类型化）

## 元信息

- issue：AlchemistCxC/Pylon-co-works#316（enhancement，已认领）
- 分支：`kumo/filesheet-stage0`（共享在途分支，其上另有 #315/#317 两批并行提交）
- 提交范围：`07f3af02..HEAD`（#316 部分；分支上混有 #315/#317 他人提交）
- 日期：2026-09-25
- spec：`.agents/spec/316-acp-v1-hardening.md`（不入库）

## 目标与范围

对照官方 ACP v1（2026-09 稳定面）与真实 agent 生态源码级实测，补强协议引擎核：修错组（stopReason/版本回显/变体分类）、fs/terminal 宿主能力"实现与广告同源"通电、elicitation 标准 form 模式（能力+GUI+complete 收敛）、官方 SDK 类型化幂等批次。**不做**：authenticate、url 模式、session/delete、logout、audio/embeddedContext、messageId/cost 消费、typed Dispatch 整体重构、`terminal/wait_for_exit` flatten wire-fix（均留后续 issue）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `pylon-acp/src/protocol.rs` | SessionUpdateVariant +AgentThoughtChunk/Plan；classify_session_update（typed-first）；PromptStopOutcome/prompt_stop_outcome（替换 prompt_stop_reason）；validate_protocol_version；prompt_blocks typed ContentBlock；session_id_from typed-first+守卫；resume_capability_advertised typed | 修改 |
| `pylon-acp/src/turn_ledger.rs` | ActivityFlags 结构体（saw_text/saw_tool/saw_thinking）；empty_turn_cause 第四参；terminal_cause_from_prompt_result 收编 max_tokens | 修改 |
| `pylon-acp/src/client.rs` | protocolVersion 回显校验接入；cancel_session typed CancelNotification | 修改 |
| `pylon-acp/src/engine.rs` | respond_error 签名 i64→ErrorCode；ElicitationComplete 控制帧 lane | 修改 |
| `pylon-acp/src/error.rs` | NOTIF_ELICITATION_COMPLETE 常量 | 修改 |
| `pylon-acp/src/host_tools.rs` | 全文件重写：HostToolsPolicy{fs,terminal} 双门控 + resolve（YAML 优先/env 兼容回退/非法 fail-closed） | 修改 |
| `pylon-acp/src/initialize_plan.rs` | build_initialize_plan 接收解析后 policy；apply_host_gates 注入/裁剪 fs·terminal；elicitation form 广告 | 修改 |
| `pylon-acp/src/terminal_runtime.rs` | release_session/clear | 修改 |
| `pylon-acp/src/lib.rs` | 导出面 | 修改 |
| `pylon-core/src/agent_config/types.rs` | HostToolsMode 枚举 + host_tools/host_terminal 字段/访问器/反序列化 + 指纹 | 修改 |
| `src/dispatcher/mod.rs` | classify 调用点；thinking 续命块；fs/terminal typed 响应；strict 沙箱根改会话工作区；elicitation/complete 分支；respond_error ErrorCode 迁移 | 修改 |
| `src/permission.rs` | watcher 死亡分支 private_interactions.cancel_all | 修改 |
| `src/lifecycle/mod.rs`、`src/runtime.rs` | policy 解析源切换 + stop_agent_runtime 终端清理 | 修改 |
| `src/session/{prompt,control}.rs`、`src/export.rs`、`src/gateway/mod.rs` | refine/判定表/elicitation 释放/classify 迁移 | 修改 |
| `src/protocol_adapter.rs` | 白名单 9 官方条目换 CLIENT_METHOD_NAMES | 修改 |
| `src/acp/{tests,catalog_driven_tests,real_acp_smoke}.rs`、`src/agent_config/tests.rs` | 测试更新/新增 | 修改 |
| `pylon-core/src/provider_adapter.rs` | 基线字面量对齐他人 #315 默认 caps 变更（代补） | 修改 |
| 前端 `permissionTypes/permissionController/agentContracts/PermissionDialog/ElicitationRequestCard(+test)` | elicitation normalize/DTO 扩展/values 透传/表单卡/interaction.resolved 兼容 | 修改+新增 |
| `src-tauri/tests/golden-traces/*.jsonl` | 十份基线重生成 | 修改 |
| `agents.example.yaml`、`docs/说明书/Pylon-项目架构参考.md`、`vendor/acp/ORIGIN.md` | 文档同步 | 修改 |

## 方案要点

1. **typed-first + raw-fallback**：所有入站分类先走官方 schema 类型，失败/缺省落原宽容路径——非 exhaustive 枚举无 serde(other)，未知判别整帧失败，宽容别名（agent_reasoning_chunk 等）是真实资产必须保留。
2. **宿主门单一解析源**：`HostToolsPolicy::resolve(YAML, env)` 的同一结论同时喂 initialize 广告注入（client 内）与 dispatcher 门禁（runtime 字段）——修复审查 P1「env=agent 时广告 fs 但每发必拒」的同源破窗。
3. **strict 沙箱根改会话工作区**：官方 fs 请求形状无 cwd，且 agent 自报 cwd 可被 prompt 注入逃逸（声明 `cwd:"C:\\"` 放大沙箱）——按 params.sessionId 查 SessionInfo.cwd；unrestricted 语义对齐门名（真不限根）。
4. **行为变化（用户批准）**：max_tokens → 合法终态（pet on_maxed + done 正常广播）；未知 stopReason → warn 降级 end_turn；空白/非字符串 stopReason 归畸形拒绝。
5. elicitation 请求侧/accept 应答保持手写宽容（ESM 方言无 mode 判别、content 任意 JSON 透传，官方类型无法表达）；仅标准通知/能力广告 typed。
6. TerminalRegistry 增生命周期清理：close_session 释放该会话终端、stop_agent_runtime 清空注册表——终端进程不再跨代泄漏。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| Rust 单测 | ✅ host 820 / pylon-acp 149 / pylon-core 118，0 failed |
| 前端 vitest（permissionController+卡片） | ✅ 28 passed |
| golden trace | ✅ 十份重生成，`--check` deterministic:true |
| fmt / 类型检查 | ✅ cargo fmt --check 0 diff；tsc --noEmit 本域无错误 |
| webview2 实机 | ⏸ 未执行（见"与 spec 的偏差"） |
| 文档同步 | ✅ agents.example.yaml/架构参考/ORIGIN.md；⚠️ 维护地图因 #317 会话在途未提交改动延后 |
| 行为断言（代码级） | max_tokens 不再 pylon_error（有测试）；未知 stopReason 降级（有测试）；thinking-only→completed（有测试）；版本不一致→protocol_version_mismatch（有测试） |

## 测试处置

新增：stopReason 判定表、version 回显校验、classify typed/别名/未知、AcpKind 分类、saw_thinking Or 与 empty_turn、host_tools 双门控 3 例、initialize_plan 注入 3 例、elicitation 前端 8 例、permissionState elicitation choose 回归。
修改：validates_prompt_stop_reasons（新语义）、catalog_driven 阶段 4（计划层注入）、runtime host_tools 测试（新缺省）、acp/tests 默认 caps 相关、golden 基线（重生成）、prompt.rs/refine 用例扩参。
代补（#315 会话的变更遗留）：provider_adapter 基线、agent_config 默认 caps 表征测试的字面量对齐。

## 证据

- 测试：`cargo test --lib`（820 passed, 0 failed）；`cargo test -p pylon-acp`（149）；`cargo test -p pylon-core`（118）；`npx vitest run`（28）；`generate-acp-golden-trace.mjs --check`（deterministic:true）
- 审查：分片 A/B/C 三轮异步子代理审查，verdict fail→must_fix 全部回填（A：fmt+借用式解析+gateway 迁移+边界测试；B：P0 沙箱根改会话工作区+P1 单一解析源；C：P1-1 reducer 硬门+P1-2 key remount+P2×4）；分片 D 审查结论见 issue 回写。

## 与 spec 的偏差

1. **webview2 实机验收未执行**：共享工作树存在 #315/#317 并行未提交改动，装包验证会把他人半成品行为算到本 issue 头上；实机清单（elicitation 卡渲染、fs 广告后真实 agent 请求、peri/hermes 对新广告反应）已写入 issue 遗留，待分支收敛后单独跑。
2. 维护地图同步延后（同上并行原因）。
3. build_initialize_plan 增加 policy 参数（spec 未预见的 P1 修复产物）。
4. dispatcher elicitation/complete 分支的行为测试以纯逻辑审读代替（提取纯函数+connected_runtime 测试为审查建议，未落入本期）。

## 未解问题（后续 issue 候选）

- `terminal/wait_for_exit` 响应 `exitStatus` 包裹层 vs 官方 flatten（疑似 wire bug，需兼容评审）
- authenticate（官方 methodId 参数；authMethods 顶层采集；_meta.terminal-auth）
- fs `line/limit` 实装；PromptCapabilities 附件预检；usage cost/messageId 消费
- session/delete、logout、additionalDirectories、audio/embeddedContext 出站
- unstable features（end_turn_token_usage/notices/compaction/plan_operations）逐项评审
- typed `Dispatch<AgentRequest, ClientNotification>` 整体重构；close_replaced/过期会话路径的终端回收
