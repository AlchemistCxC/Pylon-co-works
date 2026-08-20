import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import type { PlanEntry, PlanStatus } from '../../../domains/tasks/planTypes.ts'
import { taskSummary } from '../../../domains/tasks/taskSelectors.ts'
import { SolidCollapsibleRegion } from './CollapsibleRegion.solid.tsx'

export interface SolidTaskTreeProps {
  sessionId: string | null
  tasks: readonly PlanEntry[]
  toggleEventTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
}

export function SolidTaskTree(props: SolidTaskTreeProps) {
  const [expanded, setExpanded] = createSignal(false)

  createEffect(() => {
    const activeSessionId = props.sessionId
    if (activeSessionId !== undefined) setExpanded(false)
  })

  const target = props.toggleEventTarget ?? window
  const onToggle = () => setExpanded(value => !value)
  target.addEventListener('pylon:tasks-toggle', onToggle)
  onCleanup(() => target.removeEventListener('pylon:tasks-toggle', onToggle))

  return (
    <Show when={props.sessionId && props.tasks.length > 0}>
      <div class="task-tree" data-expanded={expanded()} data-count={props.tasks.length}>
        <button
          type="button"
          class="task-tree-summary"
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded()}
        >
          {taskSummary([...props.tasks])}
        </button>
        <SolidCollapsibleRegion open={expanded()}>
          <ul class="task-tree-list" aria-label="任务列表">
            <For each={props.tasks}>{task => (
              <li class="task-tree-item" data-status={task.status}>
                <span class="task-tree-status" aria-hidden="true">{statusGlyph(task.status)}</span>
                <span class="task-tree-content">{task.content}</span>
              </li>
            )}</For>
          </ul>
        </SolidCollapsibleRegion>
      </div>
    </Show>
  )
}

function statusGlyph(status: PlanStatus | 'unknown'): string {
  switch (status) {
    case 'in_progress': return '◐'
    case 'completed': return '✓'
    case 'failed':
    case 'cancelled': return '✕'
    default: return '○'
  }
}
