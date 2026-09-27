# Dev Record — #389 工具指示器不随调用结果翻转（终局 fence 收敛在途工具活动）

## 元信息

- issue：[#389](https://github.com/AlchemistCxC/Pylon-co-works/issues/389)
- 分支：kumo/prometheus
- 提交范围：`c1d78b5f..3ed125bd`（L.md 声明 `c1d78b5f` + 修复 `3ed125bd`）
- 日期：2026-09-27

## 目标与范围

**达成**：工具调用成功后指示器翻转到终态——hermes 的 `read`/`patch`/`write` 只发 `tool_call` 从不发 `tool_call_update`，投影层终局 fence 又只收敛消息不收敛工具，指示器永久停在「运行中/进行中」跨回合滞留。本修让回合终局时一切非终态工具活动收敛出终态，并让终态工具卡不再渲染活态进度区。

**不做**：不改 hermes 上游（另行反馈）；不做「下一个工具启动/正文流到 → 提前 settle」启发式（并行工具调用会误判）；不动 `activity.*`（process/后台任务/子代理/工作流）生命周期；不动 Rust 侧。

## 根因（实机实证）

journal 取自 F 盘实机 `pylon-data-v1.sqlite3`（profile `riccati` / agent `hermes`，2026-09-27，owner `local:smujjrcfo`，seq 1–50241 全量展开）：

- 66 个 `tool_call` 启动中 **30 个从未收到任何 `tool_call_update`**：`read:` 13/13 全灭（有 update 的 6 个 `kind=read` 实为 "skill view"/"analyze image"，是 hermes 标错 kind 的其他工具）、`edit`（`patch (replace)`/`write`）20/20 全灭、`terminal` 3 个。
- 有 update 的全部带显式 `status: completed|failed`（35+1），投影翻转正常——说明 Pylon 的正常路径没问题，坏的是「agent 不发终态」的防御。
- 投影层三处不对称：`reduceTool` 开头 fence 拒绝终局后一切迟到工具事件（已认定「工具不可能还在跑」）；`reduceSession` 终局只把 message `running` 收敛 false；工具节点停在 `tool.started` 给的 `'running'` → `normalizeToolStatus('running')` → 指示器永久「运行中」。
- 次要面：`ToolBody` 只要 `snapshot.progress !== undefined` 就渲染 ProgressSection（默认文案「进行中」），而投影按设计在终态保留首份 progress 快照（`workbenchProjectorToolLifecycle.test.ts`「accumulates start/progress fields」用例钉住），终态卡片因此滞留「进行中」+陈旧进度条。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/workbench/workbenchProjector.ts` | `reduceSession` 终局分支新增 `settleUnsettledTools` 调用 + 辅助函数（置于 `TERMINAL_SESSION_STATUSES` 常量后） | 修改 |
| `src/domains/tool/status.ts` | 新增 `isTerminalToolVisualState` 判定助手 | 新增 |
| `src/renderers/solid-workbench/chat/tool/ToolBody.solid.tsx` | `toolSettled` 派生 + ProgressSection 渲染条件加 `!toolSettled()` | 修改 |
| `src/domains/workbench/__tests__/workbenchProjectorToolLifecycle.test.ts` | 新增 describe「#389 terminal fence settles unsettled tool activities」4 例 | 新增 |
| `src/renderers/solid-workbench/chat/__tests__/ToolInvocationCard.solid.test.tsx` | 新增 describe「#389 活态进度只在工具未终态时渲染」2 例；修正 stream-stable 用例 1 处断言 | 修改 |

## 方案要点

1. **收敛时机 = 终局 fence**：与消息 `running` 收敛同拍（`reduceSession` 的 `settlesMessages` 分支）。这不是启发式——fence 语义本就宣告「本回合工具不可能再出事件」（`reduceTool` 已拒绝其后事件），状态收敛只是把既定事实落到数据上；与 ADR-0017「活性权威归内核/回合」的哲学一致。不做更早的「新工具启动即 settle」：并行工具调用（实机 31173/31174 两个 analyze image 并行）会误收敛。
2. **投向按回合结局**：`session` 终态 `completed` → 工具 `completed`；`error`/`failed`/`cancelled` → 工具 `cancelled`（被中断，不谎报成功也不谎报失败——`failed` 会染错误样式）。
3. **只动 `kind === 'tool'`**：`activity.*` 有自己的生命周期事件、可合法跨回合。
4. **终态幂等 + 引用稳定**：已终态节点不改写（重复 terminal 事件重放无副作用）；无可收敛节点时返回原数组引用，避免无谓文档替换。迟到真实终态 update 本就被 fence 拒绝，与 settle 不冲突。
5. **ProgressSection 终态隐藏**：进度是活态 UI；终态后结果区（输出 parts）讲结局，陈旧进度条只会误导。数据层不动（快照仍保留 progress，既有测试契约不变）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `tool.started`（无 update）+ `session.completed` → node/snapshot.status `completed`，标签「已完成」 | ✅ 测试钉住 |
| 非终态工具 + session 终态 `cancelled`/`error` → `cancelled` | ✅ 测试钉住 |
| 已终态（failed）工具 fence 后不被改写 | ✅ 测试钉住 |
| `activity.started`（process）fence 后不动；重复终态事件幂等 | ✅ 测试钉住 |
| 终态 + progress 快照不渲染 ProgressSection；running/unknown + progress 仍渲染（默认「进行中」） | ✅ 测试钉住 |
| 既有工具生命周期/快照契约测试全绿 | ✅ |

## 测试处置

- 修正：`ToolInvocationCard.solid.test.tsx`「keeps an expanded tool mounted while a streaming snapshot is updated」——完成后 `aria-valuenow="100"` 的断言改为 `.tool-progress-section` 不存在（契约变更：终态不再渲染活态进度）；卡片身份与展开态断言保留。
- 新增：投影 4 例 + 渲染 2 例（见改动清单）。

## 证据

- commit：`3ed125bd`（修复）/ `c1d78b5f`（L.md 声明）
- 测试：`npx vitest run src/domains/workbench src/renderers/solid-workbench` → **127 文件 1358 例全绿**；全量 `npx vitest run` → **5052 passed / 7 failed**（7 例全部是 `thirdPartySolidRenderer.integration.test.ts` 插件夹具激活失败，**stash 掉本改动后复跑同样 7 失败——存量问题，与 #389 无关**）
- 门禁：`bun run check:solid` 通过（tsc + 5 项边界/契约脚本）；`bun run lint` 仅 1 条他人域存量 warning（`GatewaySheetView.tsx`）；`bun run check:clippy` exit 0、零新增诊断（首次跑因 **G 盘 100% 满**失败 os error 112，清 `target/debug/incremental`（2.7G 缓存）后通过）
- 实机数据取证脚本与 DB 副本在仓外 `_research/`（未入库）

## 与 spec 的偏差

无实质偏差。spec 验收 5 条全部落地；第 6 条「既有生命周期测试全绿」含上述 1 例按契约变更修正（spec「测试处置」已预写「无」，实际有 1 例修正——补充在此说明）。

## 未解问题

1. **hermes 上游缺陷**：read/patch/write 不发 `tool_call_update`（疑似这些调用发生在 delegate 子代理内、update 未被转发）——本修只是 GUI 防御收敛，工具卡仍无输出内容可显示（只有 started 的 title/locations）。需上游修（发 update 或补内容），修好后 Pylon 正常路径直接吃上。
2. 本修收敛发生在**回合终局**，不是工具实际完成时刻——上游不发 update 时 wire 上不存在更早的可靠信号（并行工具使「新工具启动即 settle」不安全）。上游修复后自然回到即时翻转。
3. 存量失败 `thirdPartySolidRenderer.integration.test.ts`（7 例，与本 issue 无关）待相关域处理。

## 并行交集

`src/domains/workbench/workbenchProjector.ts`（`reduceSession` 区段 + 常量区新函数）、`src/domains/tool/status.ts`（追加导出）、`src/renderers/solid-workbench/chat/tool/ToolBody.solid.tsx`（头部 import + ProgressSection 条件）、两个测试文件。未触碰他人 L.md 在途声明的文件域。
