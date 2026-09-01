import { describe, expect, it } from 'vitest'
import { groupAdjacentToolActivities } from '../activityGrouping.ts'
import type { WorkbenchActivityNode } from '../workbenchProjector.ts'

function tool(id: string, title: string, extra: Partial<WorkbenchActivityNode> = {}): WorkbenchActivityNode {
  return { id, kind: 'tool', title, status: 'completed', orphan: false, sequence: Number(id.replace(/\D/g, '')) || 1, ...extra }
}

describe('groupAdjacentToolActivities', () => {
  it('groups adjacent same-key tools while retaining original nodes and count', () => {
    const first = tool('tool-1', 'Read')
    const second = tool('tool-2', 'read')
    const groups = groupAdjacentToolActivities([first, second, tool('tool-3', 'Write')])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ toolKey: 'read', count: 2, status: 'completed' })
    expect(groups[0]!.items).toEqual([first, second])
  })

  it('breaks on non-tools, key changes and parent changes', () => {
    const parent = tool('tool-1', 'Read')
    const child = tool('tool-2', 'Read', { parentToolCallId: parent.id })
    const afterMessage = tool('tool-3', 'Read')
    const groups = groupAdjacentToolActivities([
      parent,
      { id: 'activity-1', kind: 'activity', status: 'running', orphan: false, sequence: 2 },
      child,
      afterMessage,
    ])
    expect(groups.map(group => group.count)).toEqual([1, 1, 1])
  })

  it('uses normalized identity precedence and reports mixed lifecycle status', () => {
    const groups = groupAdjacentToolActivities([
      tool('tool-1', 'Localized Read', { canonicalName: 'fs.read', status: 'running' }),
      tool('tool-2', 'Read', { canonicalName: 'FS.READ', status: 'completed' }),
    ])
    expect(groups[0]).toMatchObject({ toolKey: 'fs.read', count: 2, status: 'mixed' })
  })
})

