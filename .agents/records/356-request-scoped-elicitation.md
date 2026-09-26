# Dev Record — #356 request-scoped elicitation 跨栈支持

## 元信息

- issue：[#356](https://github.com/AlchemistCxC/Pylon-co-works/issues/356)（feat(acp): request-scoped elicitation 跨栈支持——后端准入 + 前端应答门 + 私有交互超时回包）
- 分支：`kumo/prometheus`
- 提交范围：`0838dc6e..`（本轮全部提交）
- 日期：2026-09-27

## 目标与范围

Pylon 对所有 provider 广告 `elicitation:{form:{}}`，但官方 `CreateElicitationRequest` 不含 `sessionId`——scope 可为 `ElicitationRequestScope{requestId}`（auth/config 阶段的会话外 elicitation 合法，schema 1.9.1）。此前 Pylon 对这类请求回 `-32601`（广告⇔执行不一致）；#349 曾尝试只放后端准入，因前端三道真值门把空串当缺失 + 私有交互无超时回包（净效果 = agent 挂等一个永不来的响应）而回退。本 issue 落完整修法：后端 typed scope 投影准入 + 前端三道门放行 + 私有交互超时 drain/回包 + 说明书同步。

不做什么：`mode:"url"` 维持 fail-closed（#349 保留项）；不做 URL 模式 UI；未超时的私有交互应答路径零改动（`respond_interaction` 身份复核 `"" != ""` 为假天然通过）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-acp/src/adapter/private_ext/mod.rs` | 新增 `ElicitationScopeProjection` + `project_elicitation_scope`（typed `CreateElicitationRequest` 解析 → scope 投影）+ 单测 | 新增 |
| `src-tauri/src/dispatcher/interaction_route.rs` | `route_private_interaction` 空 sessionId 分支：elicitation 桥走投影（Request 空串入队 / Session 取回 id / 失败 -32602）；回归测试改写 | 修改 |
| `src-tauri/src/private_interaction.rs` | `session_id` 空串契约注释、`enqueued_at` 兼任超时起点 | 修改（注释/契约） |
| `src-tauri/src/permission.rs` | 新增 `check_pending_private_interaction_timeouts`（deadline drain + 回包 + 回插重试 + 队列 TimedOut）与 `private_interaction_timeout_response`（超时默认动作单一裁决点）；`interaction_list` 私有条目 deadlineMs 0→真实值；单测 ×3 | 修改 |
| `src-tauri/src/lib.rs` | `setup_spawn_permission_timeout_watcher` 扩私有 sweep 调用 + `interaction.resolved(timed_out)` 广播（**hunk 分账提交**） | 修改 |
| `src/domains/activity/interaction.ts` | `normalizeInteractionEnvelope` 的 sessionId 区分缺失与显式空串 | 修改 |
| `src/infrastructure/acp/permissionController.ts` | `normalizePermissionRequest` 放行 `elicitation && sessionId === ''`（permission 维持硬门） | 修改 |
| `src/infrastructure/acp/interactionTransport.ts` | `requireIdentity` 仅拒 sessionId 缺失（null/undefined），空串放行 | 修改 |
| `src/domains/activity/__tests__/interaction.test.ts` 等 3 个测试文件 | #356 用例追加 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | #316 段补 scope 语义 + 超时策略（**hunk 分账提交**） | 修改 |

## 方案要点

1. **typed 投影收口在 private_ext**：`project_elicitation_scope` 用官方 `CreateElicitationRequest`（serde internally-tagged + flatten）解析后按 `ElicitationScope` 投影。解析失败 = 官方形状缺失（mode/message/requestedSchema/scope 任一），调用方按 `invalid_private_payload`/`-32602` 拒绝。`Session` scope 且 id 显式空串 → Err（fail-closed：空串在前后端三道门均当缺失，入队必悬挂）。`ElicitationScope` 标注 `#[non_exhaustive]`——未知变体按 issue 措辞 fail-closed 拒绝。带非空 sessionId 的旧形状不经过 typed 解析（legacy 兼容零变化）。
2. **准入分支不改错误码词表**：非 elicitation 桥 + 空 sessionId 维持 `method_unsupported`/`-32601`（#349 规格裁决）；elicitation 桥的参数失败落既有 `invalid_private_payload`/`-32602`，不新增稳定码。
3. **超时回包的产品裁决集中在单一函数**：语义基准「超时 = 用户未应答」，回包取各桥**非承诺值**——elicitation→`cancel`（`decline` 会断言用户明确拒绝，不成立）；grok/pi 问题桥→既有 declined 映射（`skip_interview`/`cancelled:true`）；exit_plan→`keep_planning`（超时绝不批准、也不代用户弃计划）。与 `pending_permissions` 的超时默认拒绝同一「不悬挂、不批准」取向。产品要改语义只动 `private_interaction_timeout_response` 一处。
4. **claim 顺序裁决并发竞态**：sweep 先 `private_interactions.take()` 原子 claim 再构造/发送——用户应答先到则 sweep 拿 None 跳过；sweep 先 take 则用户侧得到 not found 由前端既有 not-found 路径 settle（与 `route_elicitation_complete` 的 P2-2 语义一致）。发送失败回插 store 下轮重试，不产出 outcome。
5. **超时终态事件形状与断线 drain 同构**：`interaction.resolved{agentId, sessionId(可空串), requestId, clientGeneration, kind, reason:"timed_out"}`——`permissionController.handleResolved` 对 `permission.resolved`/`interaction.resolved` 本就同一 settle 语义，workbench 时间线的交互条目（`workbenchProjector` 消费 `interaction.resolved`）也能收敛。
6. **前端放宽仅限 elicitation**：`normalizePermissionRequest` 的 `requestScoped = isElicitation && envelope.sessionId === ''`；permission 请求缺/空 sessionId 仍拒（回归测试锚定）。`respond_interaction` 后端身份复核空串==空串天然通过，零改动。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| request-scoped elicitation（mode form + requestId、无 sessionId）入桥入队，store `session_id==""`、事件 `sessionId==""` | ✅ `request_scoped_elicitation_is_admitted_with_empty_session` |
| 无 scope → -32602；显式 `"sessionId":""` → -32602；url mode 维持 -32602；非 elicitation 桥 + 空 sessionId 维持 -32601 | ✅ interaction_route 6 用例全绿 |
| 会话内 elicitation 既有行为不变 | ✅ `session_scoped_elicitation_keeps_session_id_projection` |
| 到期私有交互：agent 收到超时应答、store/队列终结、失败回插重试 | ✅ `private_interaction_timeout_sends_cancel_and_settles_with_live_responder`（真实 SDK responder）+ `..._retains_entry_when_send_fails` |
| 前端 request-scoped normalize→渲染→提交全链 | ✅ permissionController/interactionTransport #356 用例（含冷挂载 seed→choose→identity 空串透传） |
| `interaction_list` 私有条目 deadlineMs 非 0 | ✅ `interaction_list_projects_private_interactions_for_cli` |
| 说明书 #316 段同步 | ✅ |

## 测试处置

- **改写**：`elicitation_without_session_id_is_rejected_method_not_found` → `request_scoped_elicitation_is_admitted_with_empty_session`（该回归是 #349 回退期临时守卫，其注释已预告「完整修法见 issue #356」；原断言与新行为相反）。
- **保留**：`non_elicitation_bridge_without_session_id_is_rejected_method_not_found`、`unadvertised_url_mode_is_rejected_as_invalid_params`、`session_scoped_elicitation_keeps_session_id_projection`（回归面）。
- **修改**：`interaction_list_projects_private_interactions_for_cli` 的 `deadlineMs==0` 断言改为真实 deadline（契约随 #356 变更）。
- **新增**：private_ext `elicitation_scope_projection_matches_official_shapes`；interaction_route `elicitation_without_any_scope_is_rejected_invalid_params`、`elicitation_with_explicit_empty_session_id_is_rejected_invalid_params`；permission.rs `private_timeout_response_picks_the_non_committal_value_per_bridge`、两个 sweep 用例；前端 8 个 #356 用例。

## 证据

- 测试：`cargo test -p pylon-acp --lib` → **172 passed, 0 failed**；`cargo test --lib`（app crate 全量）→ **907 passed, 0 failed, 4 ignored**；`cargo fmt --all --check` → 无差异；前端定向 3 文件 **48 passed**；`bun run test:unit` → **1487 passed（183 files）**。
- commit：见 PR。

## 与 spec 的偏差

- lib.rs watcher 的扩展幅度比 spec 预估（~10 行）略大：含 import 行与两处 emit 循环，约 25 行，机制不变。
- 其余按 spec 落地，无偏差。

## 未解问题

- 超时默认动作已按「非承诺值」裁决并集中在 `private_interaction_timeout_response`；issue 中标注「需要产品裁决」——若产品要改（如 elicitation 超时改 decline），只动该函数与对应测试。

## 并行交集

- `src-tauri/src/lib.rs`、`docs/说明书/Pylon-项目架构参考.md`：两文件均有 #361-363/#371/#376+#375 的在途 hunk，本 issue 的 hunk 以**临时索引 hunk 级提交**单独入库（只含我的 hunk），未触碰他人在途内容；后续对方整文件提交时我的 hunk 已在 HEAD、不会被重复带入。
- 未触碰在途域：`pylon-acp/{engine,process,terminal_runtime}.rs`、`pylon-session/**`、`session/**`、`src/infrastructure/events/**`、`main.rs`、`logging/**`。
