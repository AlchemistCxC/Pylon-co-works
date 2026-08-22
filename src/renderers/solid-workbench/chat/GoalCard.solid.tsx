import { Show } from 'solid-js'
import type { GoalSnapshot } from '../../../domains/workbench/plan/goalModel.ts'

export interface SolidGoalCardProps {
  goal: GoalSnapshot | undefined
  reducedMotion?: boolean
  showBudget?: boolean
  foreground?: string
  mutedForeground?: string
  borderColor?: string
  background?: string
}

function statusLabel(status: GoalSnapshot['status']): string {
  switch (status) {
    case 'active': return '进行中'
    case 'complete': return '已完成'
    case 'blocked': return '已阻塞'
    default: return '未知状态'
  }
}

/**
 * C08：Goal 一等渲染（objective / status / token budget / blocked reason）。
 * 数据来自 document.goal slice 的 semantic snapshot；进度百分比是纯派生，
 * 无动画依赖（reduced-motion 只作为 data 标记暴露给主题层）。
 */
export function SolidGoalCard(props: SolidGoalCardProps) {
  const tokensUsed = () => props.goal?.tokensUsed ?? props.goal?.accounting?.tokensUsed
  const percent = () => {
    const goal = props.goal
    const used = tokensUsed()
    if (!goal?.tokenBudget || goal.tokenBudget <= 0 || used === undefined) return undefined
    return Math.min(100, Math.round((used / goal.tokenBudget) * 100))
  }
  const ariaLabel = () => {
    const goal = props.goal
    if (!goal) return ''
    const share = percent()
    return `目标：${goal.objective ?? ''}（${statusLabel(goal.status)}）${share !== undefined ? ` 预算 ${share}%` : ''}`
  }
  return (
    <Show when={props.goal}>
      {goal => (
        <div
          class="goal-card"
          data-status={goal().status}
          data-reduced-motion={props.reducedMotion ? 'true' : 'false'}
          role="status"
          aria-label={ariaLabel()}
          style={{ color: props.foreground, background: props.background, 'border-color': props.borderColor }}
        >
          <div class="goal-card-head">
            <span class="goal-card-status" aria-hidden="true">{statusLabel(goal().status)}</span>
            <span class="goal-card-objective">{goal().objective ?? '（无 objective）'}</span>
          </div>
          <Show when={props.showBudget !== false && percent() !== undefined}>
            <div
              class="goal-card-budget"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent()}
            >
              {`预算 ${percent()}%（${tokensUsed()}/${goal().tokenBudget}）`}
            </div>
          </Show>
          <Show when={goal().accounting?.timeUsedSeconds !== undefined}>
            <div class="goal-card-accounting" style={{ color: props.mutedForeground }}>
              {`${goal().accounting!.timeUsedSeconds} 秒`}
            </div>
          </Show>
          <Show when={goal().status === 'blocked' && goal().blockedReason}>
            {reason => <div class="goal-card-blocked-reason">{reason()}</div>}
          </Show>
          <Show when={goal().metadata !== undefined}>
            <details class="goal-card-metadata">
              <summary>未知字段</summary>
              <pre>{JSON.stringify(goal().metadata, null, 2)}</pre>
            </details>
          </Show>
          <Show when={goal().accounting?.metadata !== undefined}>
            <details class="goal-card-metadata goal-card-accounting-metadata">
              <summary>Accounting 未知字段</summary>
              <pre>{JSON.stringify(goal().accounting!.metadata, null, 2)}</pre>
            </details>
          </Show>
        </div>
      )}
    </Show>
  )
}
