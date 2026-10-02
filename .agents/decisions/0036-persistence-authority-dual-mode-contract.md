# ADR-0036 持久化真源双模式契约——Tauri 模式后端 SQLite 单权威，browser 预览 localStorage 直写永续保留

- **日期**：2026-09-28（决议拍板）；2026-10-01（补录入库）
- **状态**：已采用
- **关联**：issue #321（裁决来源，本 ADR 为其验收判据一）；#448（契约实施，已关闭）；#463（写穿健壮性 + 开放决策口，开放）；ADR-0025 D4（本议题自 #317 机械清偿剥离的出处）

## 背景与约束

#317 批次二调查（2026-09-25）确认仓库存在 localStorage 与后端 SQLite 双轨持久化，四点证据（当时行号，现行号见文末证据节）：

1. **identity 无条件双写**：同一 mutation 先写 localStorage `pylon-sessions` 再异步写穿后端 user_data envelope；localStorage 既是 browser 模式权威、又是 Tauri 模式缓存 + revision baseline，而后端自称唯一权威。
2. **保留策略按模式分叉**：browser 读写 localStorage；Tauri 走 `retention_policy_get/set` typed IPC（权威 = MsgRepo retention_policy 表）。
3. **消息同构双轨**：Tauri 走 typed invoke 写 msg_repo SQLite；browser 走 browserMessageRepository（localStorage）。
4. **审批模式真源分裂**：后端 set/get 仅内存 Mutex 不落盘；跨重启持久化只在前端 localStorage。

深挖调查（#321 评论区，2026-09-28）复核四点全部成立，并补充三条：

- **审批模式漂移实证 bug**：前端启动「本地有值即推送后端」，CLI 桥不经 webview 的 `set_approval_mode` 在重启后被前端旧值静默覆盖——双真源危害的实锤。
- **sessions 写放大**：`autoName` 逐帧变更触发全量 envelope 反复写盘（localStorage + SQLite 双份）。
- **customPresets / inputPrediction（含明文 apiKey）是唯一无任何保障的用户资产**：zustand persist 直连 localStorage，无 CAS 无备份。

约束：browser 预览模式（`IS_TAURI=false`，无 Tauri 后端）是受支持形态，localStorage 直写必须保留；CLI 桥等不经 webview 的消费方只能访问后端；`user_data_load/save` wire 命令面保持稳定；legacy key（`prism-sessions`、`pylon-theme` 内嵌预设、`pylon-input-prediction-settings-v1`）有迁移义务。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 维持 identity 双轨现状，只补一致性防御 | 一致性窗口与半提交分叉是结构性的；审批模式漂移已实证「双真源各说各话」不可靠；写放大与零保障资产问题无解 |
| 收敛到前端 localStorage 单权威 | 后端已是 msg_repo 与 user_data 的权威，反向迁移面更大；webview 存储受配额/清除影响、随浏览器 profile 丢失；CLI 桥读不到前端存储 |
| 每域自行裁决持久化通道 | 会复利出 #448 之前的碎片化；真源契约需要单一可陈述的规则 |

## 决定

**按运行模式分域收敛：Tauri 模式后端 SQLite 单权威；browser 预览模式 localStorage 直写永续保留——后者是契约的组成部分，不是待迁移的遗留。**

1. **权威表（Tauri 模式）**：identity（profiles/sessions/turns）与设置类（`input-prediction` / `approval-mode` / `custom-presets`）权威在后端 SQLite user_data envelope；retention policy 权威在 MsgRepo retention_policy 表；messages 权威在 msg_repo SQLite。browser 模式下 localStorage 直写即权威。
2. **前端 localStorage 的角色收缩**：Tauri 模式下只允许四种角色——①迁移源（旧 key 一次性搬家）；②影子日志（最后已知值恢复源，不作读权威）；③降级缓存（后端读失败时的兜底显示）；④首次种子（后端从未存过时的初值）。一律不作真源。
3. **写模型**：mutation 先内存生效再写穿后端；写穿失败不回滚内存（可见上报 + 降级只读或未同步标志）；并发写穿必须串行（前端链式 latest-wins 或后端专用锁），落盘序 == 内存序。
4. **对账规则（宁复活不销毁）**：hydrate 对账遇「未同步标志 + 本地/影子有较新值」→ 本地/影子赢并整份重发后端（跨会话自愈）；本地/影子为空或与后端一致 → 清标志、后端权威。
5. **迁移策略**：旧 localStorage key 默认「后端写穿成功后删除」（失败保留，幂等重试）；例外——input-prediction 的 legacy key 自 #463 起保留为影子日志（载荷含唯一凭据，写穿失败时是唯一恢复源）。

#448 已按本契约落地三域：approval-mode（后端落盘 + 启动回填 + 前端种子反转）、input-prediction、custom-presets；#463 补齐写穿健壮性（串行 + 未同步标志 + 影子对账）。**identity 写协议整体改造**（`pylon:identity-changed` 广播 / `user_session_patch` 行级修订 / 删除编排单命令化 / 前端镜像降级纯缓存）为后续阶段另批评估，当前 identity 双轨由 cache meta revision baseline + degraded-readonly + 后端有界重试缓解，不构成本契约的例外。

## 后果

- 正面：审批模式跨重启漂移（CLI set 被前端旧值覆盖）实证 bug 消除；customPresets/inputPrediction 从零保障变为 SQLite 持久 + 后端结构防守校验 + revision CAS；「后端宕机期间本地改动下次启动被静默删除」被未同步标志对账兜住；每域真源可用一句话陈述。
- 负面：identity 域双轨仍在——双写半提交的结构性窗口以 degraded-readonly 收窄而非消除，待后续阶段整体改造；写穿失败窗口依赖标志/影子补偿，quota 长期故障的复合失败仍可能回退后端值（有可见上报，非静默）。
- 风险/开放决策口（登记于 #463，待仓库主裁决，与本 ADR 不冲突）：①落盘降级外部不可查（set 返回持久化标志 / get 附健康位，wire 契约变更）；②`user_data_save` 通用命令可盲写 `approval-mode` key 绕开 `set_approval_mode` 锁路径（全仓前端无此调用，属防御面）。identity 写放大随后续阶段处置。

## 证据

- 决议原文：issue #321 评论区（2026-09-28，用户拍板「收敛到后端权威」；「browser 预览 localStorage 直写分支永续保留，Tauri 模式 SQLite 单权威」）。
- 实施记录：`.agents/records/448-persistence-convergence.md`（三域收敛 + 旧 key 迁移与搬家竞态）；`.agents/records/463-write-through-reconcile-ordering.md`（写穿串行/未同步标志/影子日志 + 并发回归钉）。
- 现状 file:line（基线 `47743a28`）：
  - `src-tauri/pylon-session/src/user_data.rs:38-55`：`UserDataKey` 六变体（profiles/sessions/browser-agent-ops/input-prediction/approval-mode/custom-presets）。
  - `src/domains/identity/identityStore.ts:42-51`（后端写穿装配）；`src/domains/identity/identityPersistence.ts:55-57`（merge-unresolved localStorage 写盘）；`src/domains/identity/sessionPersistence.ts:13-14`（`pylon-sessions` / legacy `prism-sessions`）。
  - `src/infrastructure/persistence/identityBackendSync.ts:63-121`：Tauri 下 profiles/sessions 写穿，失败 → degraded-readonly；`src/infrastructure/persistence/userDataRepository.ts:61-62`：SQLite 唯一权威声明 + 有界重试。
  - `src/infrastructure/persistence/retentionPolicyRepository.ts:62-69,109-145`：`IS_TAURI` 分叉（Tauri → `retention_policy_get/set`；browser → localStorage）。
  - `src/domains/chat/messagePersistence.ts:165-167,261`：adapter 按 `IS_TAURI` 选择（msg_repo SQLite / browserMessageRepository）。
  - `src-tauri/src/permission.rs:490-504`：`set_approval_mode` 写穿 + `approval_mode_write_lock` 串行；`:551`：`restore_persisted_approval_mode` 启动回填。
  - `src/domains/permission/approvalModeRestore.ts:40`：前端启动恢复——后端权威优先、localStorage 降级为首次种子；`src/domains/permission/approvalMode.ts:16`（`pylon-approval-mode` 降级缓存 key）。
  - `src/infrastructure/persistence/inputPredictionSettingsRepository.ts:8-15,57-68`（影子日志 + 未同步标志）；`src/infrastructure/persistence/customPresetRepository.ts:12-13,49,121-128`（未同步标志 + writeChain 链式串行）。
