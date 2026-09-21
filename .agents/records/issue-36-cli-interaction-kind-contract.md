# Dev Record — issue36 CLI interaction respond kind 契约修复 + 错误可读化

## 元信息

- issue：#36（bug：ACP 权限应答 kind 契约不一致，请求保持挂起）
- 分支：`Ru5t/Reflector`
- 提交范围：`3df68856`（L.md 开工声明）.. `fa037a2c`（修复本体）
- 日期：2026-09-22

## 目标与范围

**做**：① `pylon-cli interaction respond` 对挂起权限请求可完成应答（契约词项 `approval`，经列表投影透传消除硬编码）；② CLI 错误输出可读（结构化错误取 `.message`，禁 `String(obj)` 的 `[object Object]`）。

**不做**：后端 `protocol_adapter.rs` 门禁不做 `permission` 别名容忍（维护方核验明确反对比双词容忍）；`interaction list` 不扩展到私有交互（elicitation/ask-question）；桥 wire 契约（`error: Option<String>`）不变；GUI 链路（本就正确）零改动。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/permission.rs` | `interaction_list` 投影增加 `kind: "approval"` 字段 + doc 注释；tests 增 `interaction_list_projects_kind_for_cli_respond_passthrough`（mock app + TestStateBuilder） | 修改 |
| `src/cli/pylonCliService.ts` | `InteractionItem` 增必填 `kind`；`interaction respond` 改传 `found.kind`；`errorMessage` 归一化并导出 | 修改 |
| `src/cli/pylonCliBridge.ts` | native 回包 catch 复用 `errorMessage` | 修改 |
| `src/cli/__tests__/pylonCliService.test.ts` | 既有 respond 断言契约修正；新增 kind 透传、错误可读两用例 | 修改 |
| `docs/说明书/Pylon-CLI-命令表.md` | `interaction list`/`respond` 两行描述同步 kind 字段 | 修改 |

## 方案要点

- **词项漂移的结构性根治**：`InteractionItem` 此前无 `kind`，CLI 只能硬编码且写成了 `'permission'`（方法名味道），后端只认 `approval` → 恒拒。改为后端投影（pending_permissions 只存 request_permission 条目，kind 恒 approval）→ CLI 必填类型 → 透传，消除再次硬编码的可能。
- **错误双缺陷独立修**：Tauri 命令 reject 的是 `PylonError` 序列化对象 `{code,message}` 而非 `Error` 实例；`errorMessage` 归一化（Error→message / 结构化→message / 其余对象受控 JSON 兜底）后 service 内三处消费点（mutate 失败日志、工具包装）与 bridge 回包共用一份实现。
- kind 无 `?? 'approval'` 兜底：前后端同 ship，静默兜底会重新引入硬编码语义，宁可 fail-fast。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 允许路径：CLI respond 后 agent 收到选项结果 | ✅ wire trace：`{"id":7,"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}`；respond 返回 `responded:true`，list 复查为空 |
| 拒绝路径 | ✅ `reject_once` → `responded:true`；trace `optionId":"reject_once"` |
| 非法 optionId | ✅ `非法 optionId：bogus（可用：allow_once, reject_once）` |
| 已结束请求 | ✅ `挂起交互不存在（已应答/超时）：7` |
| kind 投影可见 | ✅ native `interaction list` 条目含 `"kind":"approval"` |
| 错误全程可读（无 `[object Object]`） | ✅ 验收全程所有失败输出均为真实文案 |
| 取消/超时/同代次身份 | ✅ 由既有 Rust 测试覆盖（`timeout_settles_and_reports_outcome_with_live_responder` 用真实 fake agent + Responder；`respond_permission_rejects_stale_generation`/`never_reaches_client`）——CLI 不便确定性驱动，未重复造 natvie 场景 |
| GUI 不受影响 | ✅ `interactionTransport.ts` 零 diff；GUI 传 `request.kind` 本就正确 |

## 测试处置

- 修改：`pylonCliService.test.ts`「covers CLI enhancements…」中 respond 断言 `'permission'`→`'approval'`（契约变更，非放松；该断言此前锁的正是错词项）；两处 mock 条目补 `kind` 字段（类型必填）。
- 新增：`interaction respond passes the projected kind through instead of hardcoding (#36)`；`surfaces structured backend errors instead of [object Object] (#36)`（含 `errorMessage` 直接契约断言）。
- 新增（Rust）：`permission::tests::interaction_list_projects_kind_for_cli_respond_passthrough`——kind 字段被移除时必红（防契约回退）。

## 证据

- commit：`fa037a2c`
- 测试：`npx vitest run src/cli/__tests__/pylonCliService.test.ts` → **16 passed**；`cargo test --lib` → **1112 passed, 0 failed, 4 ignored**（ignored 为需真实 agent 的默认忽略用例）；`cargo test --lib permission` → 20 passed
- 实机验收（F:\A-I\platform\pylon 实例，`PYLON_AGENTS_CONFIG` 指向独立测试配置，fake-agent `permission-proactive` 场景，全程 `--json`）：
  - `interaction list` → 条目含 `kind:"approval"`、requestId `7`
  - `interaction respond --args '{"requestId":"7","optionId":"allow_once"}'` → `{"ok":true,...,"responded":true}`；复查 list 为空
  - agent 侧 `--trace-file` wire 证据（两轮）：
    `{"jsonrpc":"2.0","id":7,"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}`
    `{"jsonrpc":"2.0","id":7,"result":{"outcome":{"outcome":"selected","optionId":"reject_once"}}}`
  - MCP 旁证：webview console 无错误；backend logs 仅预期 fixture 告警（假 sessionId 不映射本地会话 → hooks 跳过）
- 复现命令见上；实例二进制已替换为本修复构建（dev profile）

## 与 spec 的偏差

- 实测发现 CLI 壳（`src-tauri/src/bin/pylon-cli.rs` 的 `parse_value`）把纯数字 positional 解析为 JSON number，TS `stringArg` 拒收 → `interaction respond 7 allow_once` 报「requestId 必须是非空字符串」，须用 `--args` JSON 形式。**壳层既有怪癖，不在本 issue 与本次文件域**（issue 报告者 id 非纯数字故未触发）；真实 ACP 数字 request id 场景会踩到，建议另立 issue。
- spec 预留的「interaction_list 直接单测视 AppState 构造成本」已落地（TestStateBuilder + mock app 成本低）。

## 未解问题

- CLI 壳数字 positional 怪癖（见上）。
- `interaction list` 是否投影私有交互（elicitation 等）由后端已支持 respond 但列表不可见——超出本 issue，待定。

## 并行交集

- 无共享文件冲突。本轨文件域：`src/cli/**`、`src-tauri/src/permission.rs`、`docs/说明书/Pylon-CLI-命令表.md`。
- 同期 `#204③/#226/#155T3` 在 `Ru5t/Reflector` 并行施工（workbench/replay 域），零文件交集。
