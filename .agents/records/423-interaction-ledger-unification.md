# Dev Record — #423 审批线收口：InteractionLedger 三 store 合一 + 快照面向 wire 形状收敛

## 元信息

- issue：#423（enhancement；#417 裁决立项——与「快照面单源」两件合并一个 spec）
- 分支：kumo/prometheus（共享树施工；#424 已随 PR #430 合入后域解锁）
- 提交范围：`c255e583..`（开工声明后首个代码提交起）
- 日期：2026-09-28

## 目标与范围

**做**：
1. 单一 `InteractionLedger` 登记面——admit / settle / restore / 超时 drain 单点，deadline 归队列权威（接线 #416 下沉的 `queue.drain_expired` 严格 `now > deadline` 边界）。
2. 快照面单源——`interaction_list` 读 queue snapshot 输出 wire 形状（`pending_interactions_wire` 扩展 provider/deadlineMs），CLI 消费侧 normalize + parity 迁移。
3. #98 P2-1 的「队列与 store 失配」手工补丁收进单点（restore 回灌语义单实现）。

**不做**（R2.5 B 类，需另行裁决）：`respond_interaction` 应答构造臂的 InteractionBridge trait 化、`approve_tool_call` 定向化（agentId 定位 + 遍历兜底）、`kind` 不符报错；GUI `permissionController.ts`/reducer/渲染层（`entry.payload` 消费不变）；客户端替换路径的清理序与广播逻辑（只换 store 访问形态）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/interaction_ledger.rs` | 新模块：Ledger 结构（queue + permissions + private 三 store）、admit_permission/admit_private/restore_permission/restore_private/claim_permission（锁内复核谓词）/pending_permission/take_private/settle/drain_where_session/drain_expired/drain_disconnected + 事件构造（三份 admit json 差异单点化 + 问题桥 specs id 回写）+ 7 条单测 | 新增 |
| `src-tauri/src/runtime.rs` | 三 store 字段收编为 `pub ledger: InteractionLedger` | 修改 |
| `src-tauri/src/permission.rs` | resolve_pending 复核收进 ledger 单临界区（序不变）；restore_pending 删除（迁 ledger）；respond_interaction 私有臂走 ledger；interaction_list 重写为 queue snapshot → wire + provider 回填（删 private_interaction_item/truncate_prompt/PRIVATE_PROMPT_MAX_CHARS）；两条超时 sweep 合一 `sweep_interaction_timeouts`（dead 分支走 ledger.drain_disconnected；drain_expired 判定 + method 分流各走原应答序） | 修改 |
| `src-tauri/src/dispatcher/permission_route.rs` | 挂起分支走 ledger.admit_permission（emit 用返回事件）；签名删 pending_permissions 参数与 PermissionLock 别名 | 修改 |
| `src-tauri/src/dispatcher/interaction_route.rs` | route_private_interaction 走 ledger.admit_private（签名删 private_interactions 参数）；route_elicitation_complete 走 take_private + settle；测试注入 runtime 到 manager | 修改 |
| `src-tauri/src/dispatcher/mod.rs` | 泵删两 store 字段与传参 | 修改 |
| `src-tauri/src/lib.rs` | watcher 单点调 sweep_interaction_timeouts（广播次序不变）；agent_status 投影走 ledger.queue()；客户端替换清理走 ledger.drain_disconnected（补私有清理告警） | 修改 |
| `src-tauri/src/protocol_adapter/mod.rs` | respond_request_permission 复核走 ledger.pending_permission（canonical 双向回退单点） | 修改 |
| `src-tauri/pylon-acp/src/interaction_queue.rs` | drain_expired 去 dead_code（接线）；pending_interactions_wire 条目 +provider/deadlineMs；投影测试扩展 | 修改 |
| `src-tauri/src/session/expiry.rs`、`session_expiry_platform_tests.rs`、`session_info_tests.rs`、`test_harness.rs`、`acp/p1_wire_regression_tests.rs` | store 访问器机械迁移 | 修改 |
| `src/cli/pylonCliService.ts` | 新增 `WireInteractionEntry` 类型 + `normalizeWireInteractionEntry`（四桥展示重建 + prompt 截断随迁）；InteractionItem.deadlineMs 放宽可空 | 修改 |
| `src/cli/pylonCliDomainPorts.ts` | list() wire → normalize 接线 | 修改 |
| `src/cli/__tests__/interactionWireNormalize.test.ts` | parity 测试 9 例（期望值迁移自 Rust 旧投影断言） | 新增 |
| `docs/说明书/Pylon-项目架构参考.md` | §8.1 追加 #423 条目 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | Native ACP 行：interaction_queue 权威描述 + interaction_ledger 登记 | 修改 |

## 方案要点

1. **Ledger 形态**（调查报告 §4.3.2 允许「store 暂保留、增删只经 Ledger」）：结构体聚合三 store 挂 `AgentRuntime.ledger` 唯一字段，写路径单点方法 + 读路径受限访问器（`queue()`/`permissions()`/`private()`）——生产写点全部消失，测试直捅点经访问器机械迁移。
2. **锁序保持**：ledger 方法只锁自身 store，可被调用方嵌在 acp 锁内调用（resolve_pending 的 acp→pending 锁序不变）；claim 的复核谓词在 permissions 锁内对现行条目求值、通过才移除（TOCTOU 单临界区等价原「get 复核 + remove」）。
3. **超时 sweep 合一**：一次 `drain_expired(now_ms, TimedOut)`（deadline 权威）按 `entry.method` 分流——`session/request_permission` 走权限序（pick_option → resolve_pending，其内部 settle 对已 drain 条目幂等让位 = 原「queue 先 TimedOut」序保持）；其余走私有序（take claim → `timeout_default_response` → 发送 → 失败 restore_private）。**边界等价论证**：`elapsed_since(t) > 300_000` ⇔ `now > t + 300_000 = deadline`，逐 ms 相同；watcher 5s 粒度不变。
4. **失败恢复对称化**：私有 sweep 原先发送失败「store 回插、queue 不动」（sweep 判定在 store），改后判定在 queue，故失败回插用 `restore_private`（store + queue 回灌）——回灌条目 deadline 已过线，下轮 drain_expired 再命中（重试语义保持；微观差异：发送窗口内条目暂不在 queue 快照）。
5. **快照面单源**：`pending_interactions_wire`（引擎纯投影）条目补 `provider`（事件信封原样，可空）与 `deadlineMs`（entry.deadline_ms，None→null）——agent_status（GUI 冷挂载，多两字段无感）与 interaction_list（CLI）共用同一形状；后端仅做 provider 空串反查回填。CLI `normalizeWireInteractionEntry` 按 eventType/method 分支重建展示字段（title 虚拟值/options 白名单/400 截断/ask-user 摘要），对外表面与旧后端投影逐字段等价（parity 钉住）。
6. **specs id 回写**（显式迁移点）：问题桥 admit 时把 minted `questions[i].id` 写进事件 payload——`QuestionSpec.id` 是运行时原子计数铸造（`question-N`），wire params 不可重建，而它是 CLI 应答 values 的 key 唯一来源；store `params` 保持原文（应答构造走 question_specs）。
7. **行为收严声明**：超时判定真源从「扫 store」改为「queue deadline」——store-only 失配条目不再被超时收敛。ledger 双写使生产不可达；直接捅 store 的测试随契约改走 ledger admit。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| interaction_queue 全套（pylon-acp） | ✅ 186/186（含 drain_expired 边界钉住 + wire 投影扩展断言） |
| permission 相关单测 + #356 五回归（dead 清私有/超时默认回包表/真实 responder 结算/发送失败回插/request-scoped 准入） | ✅ pylon 940/940（五回归全部在列且绿） |
| 前端 interaction_list parity | ✅ `interactionWireNormalize.test.ts` 9/9 + 全量 `bun run test` 5120/5120 |
| `bun run check:clippy` | ✅ exit 0（基线外零新增） |
| `cargo fmt --all --check` | ✅ 干净 |
| 三份 admit json 差异逐字段保留 | ✅ 单测 `admit_permission_writes_store_queue_and_event_together` / `admit_private_event_type_variants_and_spec_id_injection` / `restore_permission_requeues_with_empty_identity` 逐字段断言 |
| resolve_pending 锁内复核/锁外发送/失败 restore 序不变 | ✅ 代码序保持（复核+claim 在 acp 锁内单临界区、发送在锁外、失败 restore 回灌） |

## 测试处置

- `permission::tests::interaction_list_projects_private_interactions_for_cli` → 改写为 `interaction_list_projects_private_interactions_wire_for_cli`（Rust 侧断言 wire 输出；item 形状等价性转移至 CLI parity）。
- `permission::tests::interaction_list_projects_kind_for_cli_respond_passthrough`：改为经 ledger admit + 补 wire 形状断言（method/state/payload/provider/deadlineMs）。
- `timeout_settles_and_reports_outcome_with_live_responder` / `private_interaction_timeout_*` 两例：登记改经 ledger admit（queue 驱动判定的契约前提）；调用改 `sweep_interaction_timeouts`。
- `respond_permission_rejects_stale_generation` / `respond_permission_stale_generation_never_reaches_client`：store 直捅改经 `ledger.permissions()` 访问器（语义不变）。
- `interaction_route.rs` 五个 route 测试 + `runtime_store_roundtrip_supports_complete_matching`：独立 owner 改为注入 runtime 到 manager、断言 `ledger.private()`（route 签名变更随动）。
- `session_expiry_platform_tests.rs` / `session_info_tests.rs` / `test_harness.rs` / `p1_wire_regression_tests.rs`：store 访问器机械迁移，无语义变更。

## 证据

- commit：`c255e583`（L.md 开工声明）+ 本记录所属代码提交（见 PR）。
- 测试：`cargo test --workspace --lib` → 9 目标全绿（940+186+9+36+137+87+22+0+181，0 failed；pylon-core `managed_probe_cleanup_kills_descendant_processes` 一次首跑红、孤立复跑绿——#417 决策项 8 已挂起的已知瞬态 flake，与本批无关，本批未触及 pylon-core）；`bun run test` → 663 文件 5120/5120；`bun run check:clippy` → exit 0（基线未动）；`cargo fmt --all --check` → 干净。
- 施工环境：`CARGO_INCREMENTAL=0`（G: 盘空间纪律，#383 先例）。

## 与 spec 的偏差

- spec 预告「restore_private 只回插 store」草稿后定为「store + queue 回灌」——sweep 判定移到 queue 后，不回灌会让失败条目脱离下轮判定（spec 方案节已按此落定，无实际偏差）。
- `lib.rs` 客户端替换清理补了私有交互清理计数告警（原为静默 cancel_all）——可观测性增强，清理序不变。

## 未解问题

- `respond_interaction` 应答构造臂仍按 bridge match 内联在 permission.rs（trait 化 = R2.4 步 6 的 InteractionBridge 部分，未获单独裁决）；下一个「X 桥对等超时/应答」类需求时建议再立。
- `approve_tool_call` 仍全 runtime 遍历、`kind` 仍被私有桥忽略（R2.5-2/3 B 类，挂起待前端承诺）。
- GUI ask-user 卡的 questionId 回退（`question-${index+1}`）与 Rust minted id（全局计数）理论上可错位——wire payload 现已带真 id，GUI 消费侧是否切换留待 #417 挂起项 6 的前端行为承诺一并裁决。
- 实机 webview2 验收未做（纯后端 + CLI 域重构、无 UI 几何/IPC 形状变化；GUI 消费面 wire 多两字段为向后兼容）。需要时按 `.agents/skills/webview2-acceptance/` 配方补。

## 并行交集

- 共享树上 #410 在途 CSS/tsx 脏文件已按仓库主指令回退（stash `backup-410-wip-before-423`，9 文件；untracked 孤儿测试 `terminalShellContract.test.ts` 移至仓外 `../backup-410-wip/`）——#410 重启时先恢复。
- 本批文件域（`src-tauri/src/{interaction_ledger,permission,runtime,lib,dispatcher/*,protocol_adapter/mod,session/*,test_harness,acp/p1_wire_regression_tests}.rs`、`pylon-acp/src/interaction_queue.rs`、`src/cli/**`、两份说明书）与 L.md 现存其他在途声明无重叠；#421 在独立 worktree。
