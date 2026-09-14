// 迁移自 scripts/test-workspace-api-normalization.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceEntries, workspaceTreeFromEntries, normalizeWorkspaceText, classifyWorkspaceError } from '../workspaceContracts.ts'

describe('workspaceContracts DTO 收窄（W2-02；迁移自 scripts/test-workspace-api-normalization.mts，P91 A1）', () => {
  it('entries 收窄：directory/file 保留，symlink/other/null 丢弃', () => {
    const entries = normalizeWorkspaceEntries([
      { name: 'src', relativePath: 'src', kind: 'directory', expandable: true },
      { name: 'main.ts', relativePath: 'src/main.ts', kind: 'file' },
      { name: 'link', relativePath: 'link', kind: 'symlink' },
      { name: 'other', relativePath: 'other', kind: 'other' },
      null,
    ])

    expect(entries).toEqual([
      { label: 'src', path: 'src', kind: 'folder', expandable: true },
      { label: 'main.ts', path: 'src/main.ts', kind: 'file', expandable: false },
    ])
    expect(workspaceTreeFromEntries([])).toEqual({ entries: [], selectedPath: null })
    expect(normalizeWorkspaceEntries({})).toEqual([])
  })

  it('损坏 DTO 不崩（缺字段/非对象/二进制响应）', () => {
    expect(normalizeWorkspaceEntries([{ name: 'x' }, { relativePath: 'y' }, 42, 'str'])).toEqual([])
    expect(normalizeWorkspaceText(null)).toBeNull()
    expect(normalizeWorkspaceText({ relativePath: 'a', content: 'x' })).toBeNull() // 缺 bytesRead 等字段不崩
    const okText = normalizeWorkspaceText({ relativePath: 'b', content: 'y', bytesRead: 1, totalBytes: 2, truncated: false })
    expect(okText?.encoding).toBe('utf-8')
    expect(normalizeWorkspaceEntries([{ name: 'bin', relativePath: 'bin.dat', kind: 'file' }])).toEqual([{ label: 'bin', path: 'bin.dat', kind: 'file', expandable: false }])
  })

  it('workspace_error 按 code 分支', () => {
    expect(classifyWorkspaceError(new Error('workspace_error: binary file')).code).toBe('binary')
    expect(classifyWorkspaceError('workspace_error: not_found').code).toBe('not_found')
    expect(classifyWorkspaceError('workspace_error: too_many entries').code).toBe('too_many')
    expect(classifyWorkspaceError(new Error('workspace_error: traversal detected')).code).toBe('traversal')
    expect(classifyWorkspaceError('something else').code).toBe('unknown')
  })
})
