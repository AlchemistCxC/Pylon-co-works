import { describe, expect, it } from 'vitest'
import { classifyWorkspaceSearchError, normalizeWorkspaceSearchResults } from '../workspaceSearchContracts.ts'

// 下沉自 scripts/test-workspace-search.mts（P91 A2）：搜索桩的宽容 normalize 与错误分类。
describe('normalizeWorkspaceSearchResults 宽容归一', () => {
  it('合法行保留、缺 line 默认 1、非法条目丢弃', () => {
    const results = normalizeWorkspaceSearchResults([
      { path: 'src/a.ts', line: 12, lineText: 'const x = 1' },
      { path: 'src/b.ts', lineText: 'no line' },
      { path: '' },
      null,
      42,
    ])
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ path: 'src/a.ts', line: 12, lineText: 'const x = 1' })
    expect(results[1]?.line).toBe(1)
    expect(results[1]?.lineText).toBe('no line')
  })

  it('非数组输入归空', () => {
    expect(normalizeWorkspaceSearchResults('not-array')).toEqual([])
  })
})

describe('classifyWorkspaceSearchError 三路径', () => {
  it('missing 命令 → blocked（待后端）', () => {
    expect(classifyWorkspaceSearchError(new Error('Command not found: workspace_search'))).toEqual({ kind: 'blocked' })
    expect(classifyWorkspaceSearchError('workspace_search 不存在')).toEqual({ kind: 'blocked' })
  })

  it('其余错误 → error 并携带消息；不可读对象兜底为「搜索失败」', () => {
    expect(classifyWorkspaceSearchError(new Error('protocol_error'))).toEqual({ kind: 'error', message: 'protocol_error' })
    expect(classifyWorkspaceSearchError('[object Object]')).toEqual({ kind: 'error', message: '搜索失败' })
  })
})
