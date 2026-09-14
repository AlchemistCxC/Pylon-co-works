// 迁移自 scripts/test-workspace-expand-read.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceText, mergeWorkspaceEntries } from '../workspaceApi.ts'

describe('workspaceApi merge + text 收窄（迁移自 scripts/test-workspace-expand-read.mts，P91 A1）', () => {
  it('mergeWorkspaceEntries：子节点挂载 + 节点转不可展开；normalizeWorkspaceText 收窄', () => {
    const tree = [{ path: 'src', label: 'src', kind: 'folder' as const, expandable: true }]
    expect(mergeWorkspaceEntries(tree, 'src', [{ path: 'src/main.ts', label: 'main.ts', kind: 'file' as const }])).toEqual([
      { path: 'src', label: 'src', kind: 'folder', expandable: false, entries: [{ path: 'src/main.ts', label: 'main.ts', kind: 'file' }] },
    ])
    expect(normalizeWorkspaceText({
      relativePath: 'src/main.ts', content: 'const x = 1', bytesRead: 11, totalBytes: 11, truncated: false,
    })).toEqual({
      relativePath: 'src/main.ts', content: 'const x = 1', bytesRead: 11, totalBytes: 11, truncated: false, encoding: 'utf-8',
    })
    expect(normalizeWorkspaceText({ relativePath: 'x', content: 'x' })).toBeNull()
  })
})
