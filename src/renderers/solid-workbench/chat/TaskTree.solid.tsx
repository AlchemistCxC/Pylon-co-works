import { For, Show, createMemo, onCleanup } from 'solid-js'
import type { WorkbenchTaskEntry } from '../../../domains/workbench/workbenchRuntime.ts'
import { SolidCollapsibleRegion } from './CollapsibleRegion.solid.tsx'
import { createCollapsiblePresenter } from './CollapsiblePresenter.solid.tsx'

export interface SolidTaskTreeProps {
  sessionId: string | null
  tasks: readonly WorkbenchTaskEntry[]
  toggleEventTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
}

export function SolidTaskTree(props: SolidTaskTreeProps) {
  const collapse = createCollapsiblePresenter({
    defaultOpen: () => false,
    resetKey: () => props.sessionId,
    idPrefix: 'solid-tasks',
  })
  const completed = createMemo(() => props.tasks.filter(task => task.status === 'completed').length)

  const target = props.toggleEventTarget ?? window
  const onToggle = collapse.toggle
  target.addEventListener('pylon:tasks-toggle', onToggle)
  onCleanup(() => target.removeEventListener('pylon:tasks-toggle', onToggle))

  return (
    <Show when={props.sessionId && props.tasks.length > 0}>
      <div class="task-tree" data-expanded={collapse.open()} data-count={props.tasks.length}>
        <button
          type="button"
          class="task-tree-summary"
          onClick={collapse.toggle}
          aria-expanded={collapse.open()}
          aria-controls={collapse.bodyId}
        >
          <span class="task-tree-summary-label">{taskSummary([...props.tasks])}</span>
          <span class="task-tree-summary-ratio" aria-hidden="true">{completed()}/{props.tasks.length}</span>
        </button>
        <progress class="task-tree-overall-progress" aria-label="任务总体进度"
          value={completed()} max={Math.max(1, props.tasks.length)} />
        <SolidCollapsibleRegion open={collapse.open()} id={collapse.bodyId}>
          <ul class="task-tree-list" aria-label="任务列表">
            <For each={props.tasks}>{task => (
              <li class="task-tree-item" data-status={task.status}
                aria-current={task.status === 'in_progress' ? 'step' : undefined}>
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

function taskSummary(entries: readonly WorkbenchTaskEntry[]): string {
  const completed = entries.filter(entry => entry.status === 'completed').length
  const base = `⇅ ${entries.length} 任务`
  return completed > 0 ? `${base} · ${completed} 完成` : base
}

function statusGlyph(status: WorkbenchTaskEntry['status']): string {
  switch (status) {
    case 'in_progress': return '◐'
    case 'completed': return '✓'
    case 'failed':
    case 'cancelled': return '✕'
    case 'blocked': return '!'
    default: return '○'
  }
}
