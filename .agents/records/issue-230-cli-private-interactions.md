# Dev Record — issue230 interaction list 投影私有交互

## 元信息

- issue：#230（enhancement：CLI 可见可应答私有交互——#36 验收遗留）
- 分支：`Ru5t/Reflector`
- 提交：`ed14e4e5`（L.md）+ `66a87542`（实现，与 #229 同提交）
- 日期：2026-09-22

## 目标与范围

**做**：`interaction list` 投影私有交互（elicitation / ask-user / exit-plan）；`interaction respond` 支持 values/text 自由作答；fake-agent 增 native 验收场景。

**不做**：不改 `respond_interaction` 私有路径（本就 fail-closed）；不给私有交互造超时结算；GUI 零改动。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/acp/adapter/private_ext/mod.rs` | `PrivateBridge::queue_kind()`——dispatcher admit 与 CLI 投影共用的单一 kind 映射 | 修改 |
| `src-tauri/src/private_interaction.rs` | store 增 `enqueued_at` 字段 + `snapshot()`；`queue_kind` 委托 | 修改 |
| `src-tauri/src/dispatcher/mod.rs` | 私有交互 insert 处补 `enqueued_at`（与队列 admit 共用同一时刻）；kind match 换 `queue_kind()` | 修改 |
| `src-tauri/src/permission.rs` | `interaction_list` 增投私有交互条目（`private_interaction_item` + 有界摘要 `truncate_prompt`）；新增投影单测 | 修改 |
| `src/cli/pylonCliService.ts` | `interaction respond`：optionId 可省（须有 values/text）；空 options 条目仅 declined；values/text 透传 | 修改 |
| `src-tauri/src/bin/pylon-fake-agent.rs` | 新增 `interact-proactive` 场景（`--proactive-method`，id/params 复用 permission 旗标） | 修改 |
| `docs/说明书/Pylon-CLI-命令表.md` | list/respond 两行同步 | 修改 |

## 方案要点

- **identity 真源**：投影取 `private_interactions` store（respond 复核的真源），provider 空时回退配置反查；kind 用 `queue_kind()`（approval/elicitation/ask-user，与队列 canonical 一致）。
- **options = 应答动作虚拟白名单**：elicitation → accept/declined/cancel；exit-plan → approved/abandoned/keep_planning；ask-user → 空（应答走 values，optionId 仅 declined）。CLI 校验规则：optionId 提供时按 options 白名单校验；省略时须有 values/text（fail-closed）。
- **私有交互无后端超时**：`deadlineMs: 0` 标注不适用；`requestedAt` 取新增 `enqueued_at`。
- prompt 有界摘要（400 chars 截断）：elicitation 取 message，exit-plan 取 planContent，ask-user 取 `questionId:题面` 串。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| list 可见私有交互 | ✅ native：`kind:"elicitation"`、options accept/declined/cancel、prompt=message、deadlineMs=0 |
| CLI respond accept+values → agent 收到 | ✅ wire trace：`{"id":"e1","result":{"action":"accept","content":{"name":"cli-acceptance"}}}` |
| values-only（省 optionId） | ✅ `responded:true`；trace `{"action":"accept","content":{"choice":"B"}}` |
| 非法 optionId（虚拟白名单） | ✅ `非法 optionId：bogus（可用：accept, declined, cancel）` |
| 已结束请求 | ✅ `挂起交互不存在（已应答/超时）：e1` |
| 权限条目投影不回归 | ✅ #36 验收序列复跑全绿 |

## 测试处置

- 新增（Rust）：`interaction_list_projects_private_interactions_for_cli`（elicitation + exit-plan 双形态断言）。
- 新增（TS）：`interaction respond answers private interactions via values/text without optionId (#230)`。
- 既有测试零修改。

## 证据

- 测试：vitest CLI 套件 **18 passed**；`cargo test --lib` → **1113 passed / 0 failed**
- native（fake-agent `interact-proactive --proactive-method elicitation/create`，全程 `--json`，wire trace 见上）
- 复现命令：见 issue #230 回写评论

## 与 spec 的偏差

无 spec（enhancement，方案在 issue 正文并按其落地）。

## 未解问题

- ask-user 的 values 应答要求调用方从 list prompt 摘要中取 questionId——自动化够用；如需完整 question specs 投影待需求。

## 并行交集

与 #229 同提交；文件域见 L.md `[2026-09-22 01]` 条目。
