import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkspaceStore, touchedFileVersionKey } from '../workspaceStore'
import { toAgentContextKey } from '../agentContext'

/**
 * I01-W3 CR-003：recordTouchedFile 生产者键写入 + 双 Agent 同名 source 隔离负例——
 * touchedFiles/touchVersions 按 AgentContextKey / context+path 二元 key 隔离。
 */
describe('workspaceStore touchedFiles 双 Agent 同名 source 隔离', () => {
  const ctxA = { agentId: 'agent-a', source: 'local:same' }
  const ctxB = { agentId: 'agent-b', source: 'local:same' }

  beforeEach(() => {
    useWorkspaceStore.setState({ touchedFiles: {}, touchVersions: {} })
  })

  it('同名 source 双 Agent 各自记录，互不共享', () => {
    const store = useWorkspaceStore.getState()
    store.recordTouchedFile(ctxA, { path: 'src/a.ts', toolKind: 'Edit', at: 1 })
    store.recordTouchedFile(ctxB, { path: 'src/b.ts', toolKind: 'Write', at: 2 })

    const s = useWorkspaceStore.getState()
    const keyA = toAgentContextKey(ctxA)
    const keyB = toAgentContextKey(ctxB)
    expect(s.touchedFiles[keyA]?.map(f => f.path)).toEqual(['src/a.ts'])
    expect(s.touchedFiles[keyB]?.map(f => f.path)).toEqual(['src/b.ts'])
    expect(s.touchedFiles[keyA]?.length).toBe(1)
    expect(s.touchedFiles[keyB]?.length).toBe(1)
    // 版本戳按 context+path 隔离
    expect(s.touchVersions[touchedFileVersionKey(ctxA, 'src/a.ts')]).toBe(1)
    expect(s.touchVersions[touchedFileVersionKey(ctxB, 'src/b.ts')]).toBe(1)
    expect(s.touchVersions[touchedFileVersionKey(ctxA, 'src/b.ts')]).toBeUndefined()
  })

  it('TouchedFile.source 保留原始 source（展示/反查用），record key 为 context key', () => {
    const store = useWorkspaceStore.getState()
    store.recordTouchedFile(ctxA, { path: 'x.ts', toolKind: 'Edit', at: 1 })
    const s = useWorkspaceStore.getState()
    const file = s.touchedFiles[toAgentContextKey(ctxA)]![0]
    expect(file.source).toBe('local:same') // 原始 source 保留在记录上
  })

  it('同 context 同 path 重复记录 → 版本戳递增，列表去重顶替', () => {
    const store = useWorkspaceStore.getState()
    store.recordTouchedFile(ctxA, { path: 'x.ts', toolKind: 'Edit', at: 1 })
    store.recordTouchedFile(ctxA, { path: 'x.ts', toolKind: 'Edit', at: 2 })
    const s = useWorkspaceStore.getState()
    const key = toAgentContextKey(ctxA)
    expect(s.touchedFiles[key]?.length).toBe(1)
    expect(s.touchedFiles[key]![0].at).toBe(2)
    expect(s.touchVersions[touchedFileVersionKey(ctxA, 'x.ts')]).toBe(2)
  })
})
