import type { WorkbenchActivityNode } from './workbenchProjector.ts'

export interface AdjacentToolActivityGroup {
  /** Stable within a projected session as long as the first activity remains. */
  readonly groupId: string
  readonly toolKey: string
  readonly items: readonly WorkbenchActivityNode[]
  readonly count: number
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'mixed'
}

function toolKey(activity: WorkbenchActivityNode): string | undefined {
  if (activity.kind !== 'tool') return undefined
  const value = activity.canonicalName ?? activity.toolKindWire ?? activity.providerName ?? activity.title
  const normalized = value?.trim().toLocaleLowerCase()
  return normalized || undefined
}

function sameParent(left: WorkbenchActivityNode, right: WorkbenchActivityNode): boolean {
  return (left.parentId ?? '') === (right.parentId ?? '')
    && (left.parentToolCallId ?? '') === (right.parentToolCallId ?? '')
}

function groupStatus(items: readonly WorkbenchActivityNode[]): AdjacentToolActivityGroup['status'] {
  const statuses = new Set(items.map(item => item.status))
  if (statuses.size !== 1) return 'mixed'
  const status = items[0]?.status
  return status === 'running' || status === 'completed' || status === 'failed' || status === 'cancelled'
    ? status
    : 'mixed'
}

/**
 * Derive display groups from an already ordered activity segment.
 * Non-tool nodes, key changes and parent changes are hard boundaries. The
 * returned items are original nodes; no activity facts or payloads are copied.
 */
export function groupAdjacentToolActivities(
  activities: readonly WorkbenchActivityNode[],
): readonly AdjacentToolActivityGroup[] {
  const groups: AdjacentToolActivityGroup[] = []
  let current: WorkbenchActivityNode[] = []
  let currentKey: string | undefined

  const flush = () => {
    if (current.length === 0 || !currentKey) return
    groups.push({
      groupId: `${current[0]!.id}:${currentKey}`,
      toolKey: currentKey,
      items: current,
      count: current.length,
      status: groupStatus(current),
    })
    current = []
    currentKey = undefined
  }

  for (const activity of activities) {
    const key = toolKey(activity)
    const previous = current[current.length - 1]
    if (key === undefined || (currentKey !== undefined && (key !== currentKey || !sameParent(previous!, activity)))) {
      flush()
    }
    if (key === undefined) continue
    currentKey = key
    current.push(activity)
  }
  flush()
  return groups
}

