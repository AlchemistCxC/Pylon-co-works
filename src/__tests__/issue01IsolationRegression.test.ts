import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRuntimeStore } from '../runtimeStore'
import { useWorkspaceStore } from '../workspaceStore'
import { toAgentContextKey } from '../agentContext'
import { openOwnedSessionTransaction } from '../application/transactions/openOwnedSessionTransaction'
import type { Session } from '../identityStore'

/**
 * I01-W5 迁移与隔离回归矩阵：双 Agent 同名 source 全链路隔离（runtime store /
 * workspace touchedFiles / owner-aware 导航）+ 快速切 Agent + 恢复失败保持原页面。
 */
function session(id: string, agentId: string, source: string): Session {
  return { id, agentId, source, name: `s-${id}`, periId: `peri-${id}`, profileId: 'p', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '' }
}

function sessionsOf(): Session[] {
  return [session('s-a', 'agent-a', 'local:同名'), session('s-b', 'agent-b', 'local:同名')]
}

describe('I01-W5 双 Agent 同名 source 隔离回归', () => {
  beforeEach(() => {
    useRuntimeStore.setState({ sessionConfig: {}, sessionModes: {}, sessionLiveStats: {}, liveGenerating: null, liveGeneratingSources: [] })
    useWorkspaceStore.setState({ touchedFiles: {}, touchVersions: {} })
  })

  it('runtime store：同名 source 双 Agent 的 config/mode/stats 完全隔离', () => {
    const ctxA = { agentId: 'agent-a', source: 'local:同名' }
    const ctxB = { agentId: 'agent-b', source: 'local:同名' }
    const store = useRuntimeStore.getState()
    store.setSessionConfig(ctxA, { model: 'model-a' })
    store.setSessionConfig(ctxB, { model: 'model-b' })
    store.setSessionMode(ctxA, 'plan')
    store.setSessionMode(ctxB, 'auto')
    store.setSessionLiveStats(ctxA, { tokensUsed: 10 })
    store.setSessionLiveStats(ctxB, { tokensUsed: 99 })
    const s = useRuntimeStore.getState()
    expect(s.sessionConfig[toAgentContextKey(ctxA)]?.model).toBe('model-a')
    expect(s.sessionConfig[toAgentContextKey(ctxB)]?.model).toBe('model-b')
    expect(s.sessionModes[toAgentContextKey(ctxA)]).toBe('plan')
    expect(s.sessionModes[toAgentContextKey(ctxB)]).toBe('auto')
    expect(s.sessionLiveStats[toAgentContextKey(ctxA)]?.tokensUsed).toBe(10)
    expect(s.sessionLiveStats[toAgentContextKey(ctxB)]?.tokensUsed).toBe(99)
  })

  it('workspace：同名 source 双 Agent 的 touchedFiles 不共享', () => {
    const ctxA = { agentId: 'agent-a', source: 'local:同名' }
    const ctxB = { agentId: 'agent-b', source: 'local:同名' }
    useWorkspaceStore.getState().recordTouchedFile(ctxA, { path: 'a.ts', toolKind: 'Edit', at: 1 })
    useWorkspaceStore.getState().recordTouchedFile(ctxB, { path: 'b.ts', toolKind: 'Write', at: 2 })
    const s = useWorkspaceStore.getState()
    expect(s.touchedFiles[toAgentContextKey(ctxA)]?.map(f => f.path)).toEqual(['a.ts'])
    expect(s.touchedFiles[toAgentContextKey(ctxB)]?.map(f => f.path)).toEqual(['b.ts'])
  })

  it('owner-aware 导航：目标 Session 的 owner ≠ activeAgent 时先切 owner 再导航', async () => {
    const calls: string[] = []
    const result = await openOwnedSessionTransaction(
      { targetId: 's-b' },
      {
        getSessions: () => sessionsOf(),
        activeAgent: 'agent-a',
        addSession: name => name,
        updateSession: vi.fn(),
        switchAgent: async () => { calls.push('switch'); return { ok: true as const, value: 'agent-b' } },
        selectSession: () => { calls.push('select') },
        openAgentSheet: () => { calls.push('open') },
      },
    )
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['switch', 'select', 'open'])
  })

  it('快速切 Agent：切换失败保持原页面（不 select 不开 sheet）', async () => {
    const calls: string[] = []
    const result = await openOwnedSessionTransaction(
      { targetId: 's-b' },
      {
        getSessions: () => sessionsOf(),
        activeAgent: 'agent-a',
        addSession: name => name,
        updateSession: vi.fn(),
        switchAgent: async () => { calls.push('switch'); return { ok: false as const, kind: 'transport' as const, message: 'agent offline' } },
        selectSession: () => { calls.push('select') },
        openAgentSheet: () => { calls.push('open') },
      },
    )
    expect(result.ok).toBe(false)
    expect(calls).toEqual(['switch']) // 切换失败后不得 select/open
  })

  it('切换期间目标 Session 被删除 → mismatch，不开 sheet', async () => {
    const calls: string[] = []
    let sessions: Session[] = sessionsOf()
    const result = await openOwnedSessionTransaction(
      { targetId: 's-b' },
      {
        getSessions: () => sessions,
        activeAgent: 'agent-a',
        addSession: name => name,
        updateSession: vi.fn(),
        switchAgent: async () => { calls.push('switch'); sessions = [] /* 切换期间目标被删除 */; return { ok: true as const, value: 'agent-b' } },
        selectSession: () => { calls.push('select') },
        openAgentSheet: () => { calls.push('open') },
      },
    )
    // 初始 getSessions 有 s-b，切换后清空 → 复查 mismatch
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('mismatch')
    expect(calls).toContain('switch')
    expect(calls).not.toContain('select')
    expect(calls).not.toContain('open')
  })

  it('恢复失败：存档无 owner → blocked，不静默归 active Agent', async () => {
    const result = await openOwnedSessionTransaction(
      { source: 'local:存档', periId: 'peri-x', title: '旧存档' },
      {
        getSessions: () => [],
        activeAgent: 'agent-a',
        addSession: name => name,
        updateSession: vi.fn(),
        switchAgent: async () => ({ ok: true as const, value: 'agent-a' }),
        selectSession: vi.fn(),
        openAgentSheet: vi.fn(),
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('blocked')
      expect(result.message).toContain('归属不明')
    }
  })
})
