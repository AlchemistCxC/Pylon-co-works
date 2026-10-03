# Dev Record — #531 插件命令执行器：mode 侧补上「回包权威」覆盖

## 元信息

- issue：[#531](https://github.com/Teens-in-Times/Pylon-co-works/issues/531)
- 分支：`fix/531-plugin-mode-readback.1`（从远端 `main` @ `940b2b81` 新建，已 `--unset-upstream`）
- 日期：2026-10-03
- 性质：bug 修复（前端状态收敛口径 + 测试）

## 目标与范围

**症状**：从**插件命令面**调 `mode`（`/mode`）时，前端走 `domains/chat/sessionModeState.ts` 的「乐观写 + 失败回滚」——**不看回包权威值**；agent 静默降级（如老 Hermes 落回 `default`）时仍显示**请求值**（= #156 / CC-26 的「选了没反应／显示骗人」形状）。

**做**：`applySessionModeChange` 在回包可提取出权威 `currentModeId` 时**以回包为准**（覆盖乐观值）—— 与 `sessionModelState` 的 P56/D3 同口径。

**不做（已知边界，记在 issue）**：空回声场景的「等待 Agent 确认」提示（本入口无展示面）；候选面 / 文档同步（那是 `runSessionControl` 的机制，插件路径无会话运行时上下文）。后端命令与校验不变（`set_mode` 的 `mode_not_advertised` 对该路径本就生效）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/chat/sessionModeState.ts` | `applySessionModeChange`：`await invokeSet` 后 `extractMode(sessionResponseObject(response))`，与请求值不同即以回包覆盖（同一 `writeMode` 入口）；补 import | 修改 |
| `src/domains/chat/__tests__/sessionModeState.test.ts` | 新增 describe「#531：回包权威覆盖」3 条（回声覆盖 / 相等不重复写 / 空回声保留乐观值） | 修改 |

## 方案要点

- **不新增 prop、不改调用面**：权威值的写入口与乐观值相同（`writeMode`），故只在函数内部补一步即可；调用方（`sessionMode.ts` / `sessionModel.ts` / 插件执行器）零改动。
- 相等时跳过（避免冗余写）；提取不到时保留乐观值（与模型侧同口径）。
- 模型侧无需改：`applySessionModelChange` 已有 `applyResponseConfig` 半边 ✓。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 回包给出与请求不同的 `currentModeId` ⇒ 以回包为准 | ✅ 新用例（`writes = ['auto','default']`） |
| 回包与请求一致 ⇒ 不重复写 | ✅ 新用例（`writes = ['auto']`） |
| 空回声 ⇒ 保留乐观值 | ✅ 新用例（`writes = ['bypass']`） |
| **反向验证**（铁律·新测试） | ✅ 把覆盖改为恒假 ⇒ 红：`sessionModeState.test.ts:100:20`、`AssertionError: expected [ 'auto' ] to deeply equal [ 'auto', 'default' ]`、1 failed / 9 passed；改回复绿（10 passed） |
| 既有用例 | ✅ 零改动、全过（原 7 条） |
| 门禁五步 | 见「证据」（lint / build:example-plugin / build / check:solid / test） |

## 测试处置

| 文件 | 处置 |
| --- | --- |
| `sessionModeState.test.ts` | **新增 3 条**（describe「#531：回包权威覆盖」）；既有 7 条一条不动 |
| 其它 | 无 |

## 证据

- commit：（收口提交，随后回填）
- 定向测试：`bun run test src/domains/chat/__tests__/sessionModeState.test.ts` → 10 passed
- 反向验证红（原文）：`FAIL … #531：回包权威覆盖 > 响应给出 currentModeId ⇒ 以回包为准覆盖乐观值（agent 静默降级不再显示请求值）` / `AssertionError: expected [ 'auto' ] to deeply equal [ 'auto', 'default' ]` / `❯ src/domains/chat/__tests__/sessionModeState.test.ts:100:20` / `1 failed | 9 passed (10)`
- 门禁五步：见 PR 描述 / 本记录「收口补记」

## 未解问题

- 空回声（agent 不回声）时本入口仍只能保留乐观值——提示面缺失属结构性（该路径无会话运行时），**已记 issue #531 边界**。
- 「候选面 / 文档同步」在插件路径不生效（同上，结构性）。

## 并行交集

- `src/domains/chat/`（会话控制状态模块族）；与 `agentWorkbenchSession.ts` 的 `runSessionControl`（新路）无文件交叠。
