# Handoff: I04-A-TEST-01

- 角色/模式：开阳（S）/ `longrun-a`
- 类型：TEST；依赖：I04-A-BE-01（已合 main）、I04-A-FE-01（已合 main）
- Base commit：`74d2621`（main，含依赖合并与 Harness 全量入库）
- 分支：`a/I04-A-TEST-01-reconnect-interleaving`
- 证据等级：**L1**（test/lint/build）
- 状态：`review_pending`，本卡证据文档交付；done 由人工（宫木云）验收

## 目标与验收

- objective：重连交错回归
- AC-1：重连交错回归；覆盖 catch 晚到、connected 早到、旧 capabilities 残留（address `docs/Issue Library/ISSUE-04.md`，对应「6.5 问题 #12」等级 1 三行）

## 新增测试（本卡生成，scope.allow 内）

- `src/components/settings/__tests__/reconnectInterleaving.test.ts`：4 个交错用例，直接驱动真实 `useRuntimeStore.setAgentStatus` + `runReconnectCommand`，逐条对应 AC-1 三种交错：
  1. **connected 早到 + catch 晚到**：command 未决期间后端先广播 connected(gen5)，随后 command reject 对账——最终保持 connected(gen5)，无本地伪造 error；
  2. **connected 早到 + accepted**：command resolve 不读快照、不覆写先到的事件；
  3. **旧 capabilities 残留**：对账权威快照 capabilities=null 时，旧 capabilities 不得经对象展开拼入；
  4. **晚到 catch 不得经旧代际对账回滚新快照**：对账读到 gen4 快照时，gen5 权威状态不被覆盖。

## 验证命令执行结果（task yaml commands.focused / broader，逐条真实输出）

| 命令 | 结果 | 证据等级 | 真实输出摘录 |
|---|---|---|---|
| `npm run test`（focused，全量 vitest） | 通过 | L1 | `Test Files 52 passed (52)`、`Tests 283 passed (283)`，Duration 25.09s（含新增 4 用例；重跑稳定无 worker 池抖动） |
| `npx vitest run src/components/settings/__tests__/reconnectCommand.test.ts src/components/settings/__tests__/agentStatusGeneration.test.ts src/components/settings/__tests__/agentStatusSelector.test.ts`（focused 专项） | 通过 | L1 | `Test Files 3 passed (3)`、`Tests 9 passed (9)` |
| `npx vitest run src/components/settings/__tests__/reconnectInterleaving.test.ts`（本卡新增） | 通过 | L1 | `Test Files 1 passed (1)`、`Tests 4 passed (4)` |
| `npm run lint` | 通过 | L1 | `eslint src/` 退出 0，无报错 |
| `npm run build` | 通过 | L1 | `tsc -b && vite build` ✓ built in 5.81s（3500+ modules，仅既有 chunk >500kB 警告，非错误） |
| `git diff --check` | 通过 | L1 | 退出 0，无 whitespace error |
| legacy guards（本卡相关四份） | 通过 | L1 | `test-agent-reconnect-transaction.mts`「agent reconnect command/lifecycle 分离回归测试通过」；`test-agent-reconnect-resolution.mts`「D-04A reconnect resolve 语义专项测试通过」；`test-agent-status-transaction.mts`「agent status transaction 回归测试通过」；`test-agent-listener-lifecycle.mts`「agent listener lifecycle 结构回归测试通过」，全部 exit 0 |

## AC-1 逐项映射

| AC-1 场景 | 覆盖用例 | 结果 |
|---|---|---|
| catch 晚到 | `reconnectInterleaving` 用例 1/4 + `reconnectCommand.test.ts`「reconciles an authoritative snapshot after command rejection」+「reports reconciliation failure without replacing the last snapshot」 | ✅ 通过 |
| connected 早到 | `reconnectInterleaving` 用例 2 + `reconnectCommand.test.ts`「does not manufacture a lifecycle snapshot when the command is accepted」 | ✅ 通过 |
| 旧 capabilities 残留 | `reconnectInterleaving` 用例 3 + `test-agent-reconnect-transaction.mts` 结构守卫（`lifecycle.capabilities` 断言不得展开旧值）+ `agentStatusGeneration.test.ts` 代际矩阵 | ✅ 通过 |

## 工作区

```text
?? src/components/settings/__tests__/reconnectInterleaving.test.ts
```

- 本卡仅新增测试文件 `src/components/settings/__tests__/reconnectInterleaving.test.ts`（scope.allow：`src/components/settings/**`）与证据文档 `docs/Issue Library/harness/handoffs/I04-A-TEST-01.md`。
- 无任何 src 业务代码改动（本卡为 TEST 卡，只生成/执行测试）。

## 阻塞与失败证据

- `validate_harness.py` 总校验报 3 处绝对路径失败，全部为**其他卡**既存 handoff，非本卡引入、不在本卡 scope.allow，未触碰、未修复：
  - `docs/Issue Library/harness/handoffs/I08-A-BE-01.md:7`
  - `docs/Issue Library/harness/handoffs/I08-A-FE-01.md:50`
  - `docs/Issue Library/harness/handoffs/I11-A-BE-01.md:19`
- 本卡证据文档与新增测试均不含绝对路径，validator 对本卡文件无报错。

## 下一条确定动作

1. 玉衡审查本 handoff 与新增测试；通过后由天璇/天权将 `a/I04-A-TEST-01-reconnect-interleaving` 合并到 main。
2. 人工（宫木云）验收：等级 1 三行验收标准在本卡已全部通过（详见 AC-1 映射）；等级 2/3 网页与真实应用验收由人在打包环境执行，本卡不越级代办。

## 不得假定

- 本卡只交付 L1（测试/lint/build）证据，未做 L2 网页 / L3 真实 Tauri/ACP 验收，不以 L1 冒充。
- 交错用例驱动的是真实 store + command 函数（单元/集成级），不包含浏览器级 UI 点击路径；UI 行为（按钮 pending 文案、操作错误提示）由 `test-agent-reconnect-transaction.mts` 结构守卫 + Settings.tsx 代码核验覆盖，未做 jsdom 组件级渲染测试。
