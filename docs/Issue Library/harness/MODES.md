# Agent 执行模式

## A 长程模式 `longrun-a`

状态循环：读任务卡 → 最小源码调查 → 写失败测试/验证 fixture → 实现 → focused test → broader test → scope guard → commit → handoff → 下一子任务。

允许连续自主推进同一任务卡内的子任务；不得跨过人工决策点或领取另一张有冲突的卡。

## B 规划书长程模式 `longrun-b`

与 A 相同，但额外要求：

- 只在 B ownership 和 frozen contract 内实施。
- 每个视觉任务定义 reduced-motion、性能预算、低性能降级和无特效 fallback。
- L2 至少覆盖目标 viewport、交互状态、截图或录屏证据；沉浸模式最终要求 L3。

## B 交互问答模式 `interactive-b`

Agent 先实现可预览的最小变化，再在 `questions` 中记录决策点。以下情况必须问 B 本人：

- 动画时长、easing、密度、色彩、镜头节奏存在多个合理答案。
- 修改会扩大 DOM 结构、公共 token、overlay 层级或输入行为。
- Preview 与规划书冲突。
- 性能预算需要牺牲视觉目标。

每次问题必须包含：当前证据、最多三个可选项、推荐项、各自影响。回答写入任务卡 `decision_log` 后续跑；不能只留在聊天上下文。

## 模式切换

- `interactive-b → longrun-b`：所有开放问题已记录答案，scope 与验收冻结。
- `longrun-b → interactive-b`：出现新的视觉取舍，不回滚已验证基线，写 checkpoint 后暂停。
- 任何模式 → `blocked_decision`：产品行为变化。
- 任何模式 → `blocked_contract`：共享契约未冻结或漂移。

模式切换只改执行策略，不改变 task id、分支或已有证据。
