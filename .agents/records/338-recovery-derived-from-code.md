# Dev Record — #338 错误中心恢复动作按错误码派生

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 规格：`.agents/spec/338-recovery-derived-from-code.md`（一次性，未入库）。

## 元信息

- issue：#338（bug：恢复动作与错误类型错配，来源 #325 施工发现）
- 分支：`kumo/prometheus`
- 提交范围：`c4479d83..HEAD`（含协调板提交与本次代码提交）
- 日期：2026-09-25

## 目标与范围

**做什么**：恢复动作默认由错误码表派生（可执行文件不存在 → 「选择可执行文件」；配置域 → 「打开 Agent 设置」；传输/初始化 → 「查看运行日志」），解释与动作同源（`ERROR_CODE_EXPLANATIONS` 单表）；72 处调用点的无脑覆盖全部移除，`options.recovery` 降级为「确实知道更准动作时」的显式覆盖；映射被单测钉住。

**不做什么**：不动 `recoveryAction`（重试类）槽位的存在形态——它与 `recovery`（诊断类）在 `ErrorCenter` 已是两个并列按钮，正交结构本就成立，本 issue 只修 `recovery` 槽被覆盖的错配；不给「工作台运行时失败」的裸 `Error` 补码提取（错误串无结构化码，属独立增强面）；不改 Rust 侧错误码词表。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/errorCodeExplanations.ts` | `ErrorCodeExplanation` 增加可选 `recovery?: RecoveryKind`；25 个码标注恢复动作（2 个 `select-agent-executable`、11 个 `open-agent-settings`、12 个 `open-runtime-log`） | 修改 |
| `src/runtimeError.ts` | `recoveryForCode` 由 6 码 switch 改为查码表 + 无果兜底 `open-runtime-log`；`formatRuntimeError` 三个分支（Error/wire/string，含 null/undefined）统一带派生 recovery；`RuntimeErrorRecovery` 删除无消费者的 `sessionId/sheetId/suiteId` 字段；`RuntimeErrorOptions.recovery` 注释改为「显式覆盖才传」；清理指向已不存在的「施工文档 §5.3」的过期注释 | 修改 |
| 30 个生产文件（调用点） | 删除全部 **72 处** `recovery: { kind: 'open-runtime-log', … }` 硬编码行——调查确认 `openRecovery`（`ErrorCenter.tsx`）是 recovery 唯一消费者，只读 `kind` 与 `agentId`，故这 72 行（含其 `sessionId/sheetId/suiteId`）本就无行为效果，删除行为中性；派生结果从此接管 | 删除 |
| `src/__tests__/runtimeError.test.ts` | 既有 wire 用例的 `recovery: undefined` 断言改为兜底值；新增派生（executable/settings/兜底）与覆盖语义用例 | 修改 |
| `src/__tests__/errorCodeExplanations.test.ts` | 新增「#338 恢复动作同源派生」describe：recovery 值合法性、关键码 → kind 精确钉死、`recoveryForCode` 查表/兜底 | 修改 |

## 方案要点

1. **同源**：恢复按钮路由不再有第二张映射表——`recoveryForCode` 直接查 `ERROR_CODE_EXPLANATIONS[code].recovery`。hint 说「去设置里改」的码，按钮就路由到设置，解释与动作天然一致。
2. **兜底语义**：查表无果（含无码错误）→ `{ kind: 'open-runtime-log' }`。该按钮是纯诊断动作（查看日志不承诺修复方式），常在比缺席安全；同时使 72 处删除对用户可见行为的影响收敛为「错配的码换了正确按钮，其余不变」。
3. **覆盖语义反转的落点**：`options.recovery` 保持硬覆盖（`ErrorCenter` 恢复失败透传 `entry.recovery` 是现存唯一非测试用法，合理保留）；但调用点面上已无任何硬编码，此后新增覆盖必然是有意为之。
4. **标注范围**：只标 hint 语义已指向可路由动作的码；`detection_budget_exhausted`（重试探测）这类「重试类」动作不标——那是 `recoveryAction` 槽的职责，两槽正交。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `agent_executable_missing` → `select-agent-executable` 且带 agentId | ✅ `runtimeError.test.ts` #338 派生用例 |
| `config_write_error` → `open-agent-settings` | ✅ 同上 |
| 无码错误（Error/string/wire）→ 兜底 `open-runtime-log` | ✅ 同上 |
| 显式 `options.recovery` 覆盖派生、未传时走码表 | ✅ `reportRuntimeError` 覆盖语义用例 |
| 码表 recovery 值合法 + 关键码钉死 | ✅ `errorCodeExplanations.test.ts` #338 describe |
| 生产面 `recovery: { kind: 'open-runtime-log'` 计数 | ✅ grep = 0（改前 72） |
| 全量测试 | ✅ 652 文件 / 4994 用例通过（1 skipped / 1 todo 为既有） |

## 测试处置

- 修改：`runtimeError.test.ts`「后端 wire 错误…」用例——`user_data_unavailable` 的 `recovery: undefined` → `{ kind: 'open-runtime-log' }`。**契约变更**：码表未标注的码从「无恢复按钮」变为「日志兜底按钮」，与 72 处删除前用户可见行为（每个错误都有日志按钮）一致。
- 其余既有用例零修改通过。

## 证据

- commit：见 PR（代码单提交 + 协调板提交）
- 测试：`npx vitest run` → `Test Files 652 passed | 1 skipped (653)`，`Tests 4994 passed | 1 skipped | 1 todo (4996)`，退出码 0
- 门禁：改动文件 eslint 零告警；`npx tsc --noEmit` 仅剩的 2 个错误位于**他人共享工作树在途文件**（`Sidebar.tsx`/`AgentSheetPageHost.tsx`，sidebar surface protocol 在途工作），与本次改动无关，本批文件零类型错误

## 与 spec 的偏差

无实质偏差。spec 的「72 处」按非测试面口径计数，与 issue 一致；实施时确认测试面也无人构造 `open-runtime-log` recovery，测试零涉及。

## 未解问题

- 「工作台运行时失败」类裸 `Error` 无结构化码，恒走日志兜底；若日后希望它给出更准动作，需在错误产生点携带码（独立增强，未施工）。

## 并行交集

- `src/errorCodeExplanations.ts`、`src/runtimeError.ts`：#325 已合入，本次在其上收敛，无在途冲突。
- 施工期间发现共享工作树出现他人改动（`src/components/Sidebar.tsx`、`src/components/sidebar/AgentSheetPageHost.tsx`、untracked `src/plugin-runtime/{sidebar,context-panel}/*SurfaceProtocol.ts`）：**本批未触碰、未提交**，提交用 pathspec 严格排除。
