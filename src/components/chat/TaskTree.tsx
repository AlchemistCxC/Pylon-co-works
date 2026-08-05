import { useState, useEffect } from 'react'
import { useChatRuntimeSnapshot } from './useChatRuntimeSnapshot'
import { taskSummary } from '../../domains/tasks/taskSelectors.ts'
import type { PlanStatus } from '../../domains/tasks/planTypes.ts'

/**
 * TaskTree — 任务树（P1-06，§8.3）。
 *
 * 挂在 ChatView .term 内、GenerationFooter 之后、bottomRef 之前。数据经横向订阅
 * （P1-05）读当前 rendered source 的 planEntries：无任务返回 null；折叠态显示摘要
 * 文案（保留供折叠使用），展开态完整三态列表。展开由 tasks widget 跨区桥
 * （window CustomEvent `pylon:tasks-toggle`，P1-07 登记）驱动；会话切换重置、不持久化
 * （D24）。turn 间持续：done 不清 plan（reducer 语义），新 plan 全量替换。
 */

interface Props {
  source: string | null
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

export default function TaskTree({ source }: Props) {
  const { tasks } = useChatRuntimeSnapshot(source)
  const [expanded, setExpanded] = useState(false)

  // 会话切换重置展开态（D24：不持久化）
  useEffect(() => {
    setExpanded(false)
  }, [source])

  // 跨区桥：tasks widget（ControlCenter）点击 dispatch pylon:tasks-toggle
  useEffect(() => {
    const onToggle = () => setExpanded(previous => !previous)
    window.addEventListener('pylon:tasks-toggle', onToggle)
    return () => window.removeEventListener('pylon:tasks-toggle', onToggle)
  }, [])

  if (!source || tasks.length === 0) return null

  return (
    <div className="task-tree" data-expanded={expanded} data-count={tasks.length}>
      <button type="button" className="task-tree-summary" onClick={() => setExpanded(previous => !previous)} aria-expanded={expanded}>
        {taskSummary(tasks)}
      </button>
      {expanded && (
        <ul className="task-tree-list" aria-label="任务列表">
          {tasks.map((task, index) => (
            <li key={index} className="task-tree-item" data-status={task.status}>
              <span className="task-tree-status" aria-hidden="true">{statusGlyph(task.status)}</span>
              <span className="task-tree-content">{task.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
