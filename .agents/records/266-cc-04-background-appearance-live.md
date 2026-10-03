# Dev Record — #266 CC-04 后台 Sheet 外观实时（暂停门收窄）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/266-cc-04-background-appearance-live.md`

## 元信息

- issue：#266（CC-04）
- 分支：`fix/cc-04-background-appearance.1`（基于 `origin/main` e7ea0828）
- 提交范围：**随本单存档点提交**（用户 2026-10-03 明示；sha 随下一笔回填；基线 = `origin/main` e7ea0828）
- 日期：2026-10-03

## 目标与范围

后台 Sheet 的渲染器 `pause()` 时，外观订阅被 `if (!destroyed && !paused)` 一并跳过 ⇒ 后台 DOM 停在旧值、切回才补读。本单把外观订阅从暂停门里放出来：pause 的省算力本意是给 runtime 流（该语义保留不动）；外观是低频用户操作，不吃这道门。

**不做什么**：不动 `streamingDisplay.pause()` / `setPausedSignal` / `data-paused`（runtime 流冻结语义保持原样）；不动 `resume()` 补读逻辑（幂等，保留）；不改既有用例断言。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/mountSolidWorkbench.solid.tsx` | `unsubscribeAppearance` 订阅回调：删 `&& !paused`，补注释「外观不吃暂停门（低频、用户驱动）；暂停只保 runtime 流；resume 仍补读一次（幂等）。」 | 修改 |
| `src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` | 既有用例「pause 冻结 runtime/appearance 推送…」仅改标题为「pause 冻结 runtime 推送（外观保持实时）…」，断言与结构一字未动；其后新增用例「pause 期间外观变更即时生效（后台 DOM 不滞后）」 | 修改 + 新增 |

## 方案要点

- 暂停门收窄只发生在外观订阅一处：`if (!destroyed) setAppearanceSnapshot(...)`。runtime 流的冻结仍由 `streamingDisplay` 调度器回调里的 `if (destroyed || paused) return`（mountSolidWorkbench.solid.tsx 调度器构造处）与 `pause()/resume()` 生命周期承担，本单零触碰。
- `resume()` 内既有 `setAppearanceSnapshot(services.appearance.getSnapshot())` 补读成为幂等兜底（暂停期间外观已实时，resume 再读一次结果相同），故不改。
- 新用例的正控断言（非编辑态 `中控元件` group 为 null）依据同文件既有写法：`services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })` 后该 group 即时出现（默认挂载态可读，无需 `lifecycle.update` 兜底）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 外观订阅处仅删 `!paused` 一个条件，其余一字不动 | ✅（diff 核对） |
| `grep -n "!paused" mountSolidWorkbench.solid.tsx` 外观订阅处 0 命中 | ✅（仅剩 resume 守卫 1 处，属单子明令保留的 resume 语义） |
| 既有 1775 用例除标题外不动任何断言 | ✅（diff 核对） |
| 新用例反向验证红 | ✅（见下） |
| 门禁五步全绿 | ✅（EXIT 全 0） |
| 全量用例数 = 基线 +1 | ✅（5128 passed；改动仅 +1 `it`，无删除） |
| 契约快照 diff 仅 `generatedAt`，已 restore | ✅ |

## 测试处置

- 改：既有用例「pause 冻结 runtime/appearance 推送，resume 一次收敛最新快照」→ 标题改为「pause 冻结 runtime 推送（外观保持实时），resume 一次收敛最新快照」（原标题与新契约不符；该用例只断言 runtime 文本与 `data-paused`，本就不覆盖外观冻结，断言零改动）。
- 新增：「pause 期间外观变更即时生效（后台 DOM 不滞后）」——pause 后正控断言 group 不在场 → dispatch `set-cc-edit-mode` → `findByRole('group', { name: '中控元件' })`（暂停中即时出现）+ `data-paused="true"` 仍在。

## 证据

- commit：随本单存档点提交（sha 随下一笔回填）。
- 测试：
  - 门禁五步：`bun run lint`（`$ eslint src/`）EXIT=0；`bun run build:example-plugin`（`Done in 8ms`）EXIT=0；`bun run build`（`✓ built in 12.96s`）EXIT=0；`bun run check:solid`（边界检查通过；主题字段 176）EXIT=0；`bun run test`（`5128 passed | 1 skipped | 1 todo (5130)`，656 文件绿）EXIT=0（重跑一次以 `; echo EXIT=$?` 直取，非管道尾）。
  - 单文件：`bun run test src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` → `102 passed`（基线 101 + 1）。
  - 反向验证：临时把 `&& !paused` 加回外观订阅后，`bun run test <该文件> -t "pause 期间外观变更即时生效"` 变红：`× pause 期间外观变更即时生效（后台 DOM 不滞后）`，红在 `await screen.findByRole('group', { name: '中控元件' })`（`src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx:1799:18`，Testing Library findByRole 超时找不到该 group = 外观被冻结的表现）→ 改回后复绿。
- 手工验证：本单为逻辑门收窄，行为由新增单测与反向验证锁定；未走实机验收（纯订阅门改动，无布局/IPC/时序面）。
- 契约快照：`bun scripts/check-workbench-theme-contract.mts --write` 后 `git diff` 仅 `generatedAt` 一行变化，已 `git restore`。

## 与 spec 的偏差

无（本单以施工单为方案唯一来源，四处改动全部按单执行）。

## 未解问题

无。

## 并行交集

- `src/renderers/solid-workbench/mountSolidWorkbench.solid.tsx`
- `src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx`
