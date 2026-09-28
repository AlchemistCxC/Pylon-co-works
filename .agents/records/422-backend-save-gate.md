# Dev Record — #422 B1 保存门禁后端化（update_agents_config 连接测试凭证校验）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#422（#417 裁决第 3 项，仓库主 2026-09-28 批复）
- 分支：`kumo/prometheus`（共享树，基线含 github/main `b5768d76` 合并）
- 提交范围：`c008a09c..HEAD`（c008a09c 为 L.md 留言提交）
- 日期：2026-09-28

## 目标与范围

**达成**（issue 期望行为原文）：
1. 后端在保存路径校验「本次提交的草稿指纹曾通过连接测试」的凭证（凭证形态在 spec 定：选**后端指纹映射**，非回执 token）。
2. 前端三道门保留（`agentDraftMachine` / reducer / `AgentRuntimePanel` 拦截零改动，RuntimePanel 保存链零改动）。
3. 校验 fail-closed：无有效凭证拒绝保存，错误码 `config_verification_required` 进前端码表。
4. 说明书 §9 改回后端强制表述。

**不做的**（spec 裁决边界）：scope=agent_create 不校验（「未验证导入」是 #425 件5 裁决保留的产品功能）；agent_delete / gateway 不校验（不改 launch 指纹）；`initialize_agents_config` 不校验（embedded 首次物化 = create 语义，现有调用点不承载编辑路径）；`test_agent_connection` 不签发（指纹未变更的保存走「未变更放行」，该路径无消费点）；revision CAS / lease / `.bak` / hard max 写入链不动；无 TTL（失效条件 = 指纹变更，未变更沿用——issue 约束原文的示例方案）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-core/src/agent_config/types.rs` | `ConfigError::VerificationRequired` 变体 + `code()` 映射 | 新增 |
| `src-tauri/src/lifecycle/verification.rs` | `VerificationVouchers`（agent_id → 有界指纹集合，每 agent 上限 8、去重刷新；`record`/`contains`）+ 单测 3 条 | 新增 |
| `src-tauri/src/lifecycle/connection_test.rs` | `test_agent_candidate` +`agent_yaml` 可选参数（YAML 整块入口）；握手成功签发凭证：`voucher_def`（结构化路径与 registry base 合成 = `apply_agent_field_patch` 候选同构；yaml 路径整块原样）、`record_verification_voucher`（effective config 父目录 resolve 后算 `runtime_fingerprint`）；`parse_agent_yaml_def`；单测 3 条 | 修改 |
| `src-tauri/src/lifecycle/config_cmds.rs` | `update_agents_config_via` 步骤 4.5 调 `enforce_connection_voucher`（写盘前 fail-closed）；纯函数 + 单测 2 条 | 修改 |
| `src-tauri/src/lifecycle/mod.rs` | mod 声明 + tests：命令层行为测试 6 条（无凭证拒 / 凭证过 / 旧凭证失效 / 未变更放行 / create 豁免 / 真实握手端到端签发→消费） | 修改 |
| `src-tauri/src/lib.rs` | AppState +`verified_agent_fingerprints` 字段（build_app_state 单点初始化） | 修改 |
| `src/infrastructure/acp/agentClient.ts` | `testAgentCandidate` +可选 `agentYaml` 第三参 | 修改 |
| `src/components/settings/AgentConfigEditor.tsx` | `saveWithVoucherRetry`：保存遇 `config_verification_required` 自动对该 YAML 补一次真实连接测试并重试；测试失败不保存 | 修改 |
| `src/components/settings/__tests__/AgentConfigEditor.test.tsx` | 补测重试 3 条（成功重试 / 测试失败不重试 / 非门禁错误不补测） | 修改 |
| `src/app/errorCodeExplanations.ts` + `__tests__` | `config_verification_required` 词条 + 封闭词表期望集同步 | 修改 |
| `vitest.setup.ts` | `AgentConfigEditor.test.tsx` 登记 console.error 白名单（错误路径契约，同 AgentRuntimePanel 先例） | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | §9 门禁表述改回前后端双层（后端强制） | 修改 |

## 方案要点

1. **凭证形态：进程内指纹映射**（spec 裁决）。`test_agent_candidate` 成功握手 → `resolve_paths(外部配置目录)` → `runtime_fingerprint()` 记入 `AppState.verified_agent_fingerprints`；保存时候选指纹变更则查表。与前端状态机 `verifiedFingerprint === fingerprint` 语义同构；保存请求形状不变（RuntimePanel 路径零改动即通过）；第三方绕过 UI 也必须先真实握手一次。重启清空 = 重新测试（fail-closed；重启后草稿本就丢失）。
2. **指纹与候选同构是正确性关键**。前端测试只传 5 字段（name/provider/transport/exe/args），而保存候选（`apply_agent_field_patch`）保留 registry 的高级字段（env/cwd/acp/hermes_profile…）——直接用测试 def 记指纹会在「已存配置带高级字段」时永不匹配（测试成功但保存被拒）。签发时与 registry base 合成，精确复刻候选合成语义；`agent_yaml` 整块路径则原样（省略字段两边都走默认）。路径归一化：两侧同用 `resolve_paths(effective_config_path 父目录)`，与 `parse_agents` 的候选侧 resolve 同 base。
3. **门禁判据**（`enforce_connection_voucher`，纯函数）：scope∈{agent, agent_fields} 且候选指纹 ≠ registry 当前指纹 → 需凭证；相等 → 放行（只改 name/default 的保存不强制在线探测——issue 约束「指纹变更才要求新凭证」）。registry 与磁盘一致性由全程持锁 + revision CAS 保证（test 与 save 之间他人改配置必先触发 CAS 冲突）。
4. **`AgentConfigEditor` 收口**：它是无三道门的内置 YAML 直存入口（Settings.tsx / OverviewSheetView 可达）——正是 issue 所述「绕过 UI」的内部例子。补测重试为 lazy 语义：指纹未变更的保存零额外探测；被拦才对该 YAML 真测一次再重试。
5. **transport 单值前提**：`transport` 合法值仅 `subprocess`（load.rs 校验），前端硬传与 registry 值恒等，无不一致风险；`runtime_fingerprint` 排除 name/default 显示字段（既有语义，PendingRestart 判定同源），故改 name 不触发门禁、与前端「改 name 需重测」的更保守口径兼容（前端重测后凭证指纹不变，幂等重记无害）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| scope=agent_fields 改 exe 无凭证 → 拒（`VerificationRequired`），磁盘与 registry 不变 | ✅ `update_agents_config_rejects_launch_change_without_voucher` |
| 有效凭证（按候选指纹）→ 保存成功，磁盘 + 内存提交 | ✅ `update_agents_config_allows_launch_change_with_voucher` |
| 凭证对应指纹 A、保存指纹 B → 拒 | ✅ `update_agents_config_rejects_stale_voucher_for_changed_fingerprint` |
| 只改 name（指纹不变）无凭证 → 放行 | ✅ `update_agents_config_allows_unchanged_fingerprint_without_voucher`；既有 `update_agents_config_write_failure_keeps_memory_and_disk_unchanged`（改 name 路径）不破坏 |
| agent_create 无凭证照常 | ✅ `agent_create_scope_does_not_require_voucher` + 纯函数层 delete/gateway 豁免断言 |
| 端到端：真实握手（pylon-fake-agent alive）签发 → 同指纹保存消费放行 | ✅ `test_agent_candidate_alive_signs_voucher_consumed_by_update` |
| YAML 入口：非法 YAML / 缺 name/exe 拒绝；合成保留高级字段 | ✅ `parse_agent_yaml_def_*` / `voucher_def_merges_editable_fields_onto_registry_base` |
| 前端码表词条 + 编辑器补测重试 | ✅ 码表封闭词表测试绿；`AgentConfigEditor voucher retry (#422)` 3 条绿 |
| 说明书 §9 改回后端强制 | ✅ 已改为「前后端双层（#422 起后端强制）」表述 |

## 测试处置

- 新增：Rust 15 条（命令层 6 + vouchers 3 + yaml 解析/合成 3 + 纯函数门禁 2 + 码表……前端 3 条组件 + 词表 1 处期望集扩充）。
- 修改既有测试 2 处：`test_agent_candidate_native_process_returns_failure_diagnostics`（签名 +`None` 参数，行为不变）；`errorCodeExplanations.test.ts` 期望集 +1 码（封闭词表机制本身要求的显式扩充）。
- 删除：无。

## 证据

- commit：见 PR（本记录随同提交）。
- 测试：`cargo test --workspace --lib` 9 目标 **1613 passed / 0 failed**（lifecycle 44 条含新增 6 条，pylon-core 137 条）；`cargo fmt --all --check` 通过；`bun run check:clippy` exit 0（`added: []` 全 crate，基线未动）；`bun run lint` 0 error（余 1 条既有 warning 属 `GatewaySheetView.tsx`，非本批文件）；前端受影响面（AgentRuntimePanel.default / typedClients / tauriClients / errorCodeExplanations / AgentConfigEditor）**76 passed / 0 failed**。
- 手工验证：未做实机 webview2 验收（纯 IPC/门禁逻辑，非 UI/布局/几何改动；mock app 命令层测试已覆盖行为面）。

## 与 spec 的偏差

- spec 验收第 6 条原写「凭证可被后续 scope=agent 保存消费」——实现为 scope=agent_fields 的端到端（同一门禁函数同一判据，agent 路径由纯函数层 + YAML 解析测试覆盖）；差异仅测试组合方式，无行为差异。
- `AgentConfigEditor` 补测时 `agent` 字段传 placeholder（`exe: '-'`）：`agent_yaml` 模式下后端忽略该字段；旧后端不识别 `agentYaml` 时拿 placeholder 测试必失败 → 降级为「连接测试未通过，未保存」，不会误保存（向后兼容 fail-closed）。

## 未解问题

1. 同一指纹的凭证在进程生命周期内不过期（无 TTL）：若 agent 二进制被外部删除，曾验证的指纹仍可保存——与前端三道门口径一致（issue 约束明示「未变更沿用」），如需时效收紧另立 issue。
2. `AgentConfigEditor` 的 textarea 不预填当前配置（既有交互，占位符「粘贴 Agent 配置」），补测重试只依赖用户粘贴内容，不受影响。
