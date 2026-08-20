/**
 * removeSessionTransaction 行为测试（报告阶段 3.2 + DEL-03 §5.13 本地优先）：
 * 本地删除失败可重试（不清理）、远端 close/finalize 失败仅报告不阻断本地删除、
 * 成功后清会话与消息缓存、会话不存在 validation。
 */
import { describe, expect, it, vi } from 'vitest'
import { removeSessionTransaction, sessionDurableOwnerKey } from '../removeSessionTransaction'
import type { Session } from '../../../identityStore'

const SESSION: Session = {
  id: 's1', agentId: 'peri', name: '会话一', source: 'local:x', profileId: 'p', createdAt: 0,
  lastActiveAt: 0, platform: 'local', workdir: '', sessionPrompt: '',
  skills: [], hooks: [], autoName: '',
}

function createDeps(overrides: Partial<Parameters<typeof removeSessionTransaction>[1]> = {}) {
  const calls: string[] = []
  const deps = {
    findSession: (id: string) => (id === SESSION.id ? SESSION : undefined),
    // DEL-03：本地优先删除——deps 收 Session（调用方从中构造 OwnerKey）
    deleteSessionLocal: async (session: Session) => { calls.push(`delete:${session.id}@${session.agentId}`) },
    // DEL-04：删除终态——主动 cancel 调度器未落盘写
    markSessionDeleted: (id: string) => { calls.push(`markDeleted:${id}`) },
    // OWNER-02：close 目标 owner 由 session 携带（agentId + source 一并传递）
    closeSession: async (session: Session) => { calls.push(`close:${session.source}@${session.agentId}`) },
    finalizeSessionDelete: async (session: Session) => { calls.push(`finalize:${session.id}@${session.source}`) },
    removeSession: (id: string) => { calls.push(`remove:${id}`) },
    clearMessages: (id: string) => { calls.push(`clear:${id}`) },
    reportError: vi.fn(),
    ...overrides,
  }
  return { deps, calls }
}

describe('removeSessionTransaction（DEL-03 本地优先）', () => {
  it('tombstone owner 使用 runtime source，不误用 metadata id', () => {
    expect(sessionDurableOwnerKey(SESSION)).toBe('["p","peri","local:x"]')
  })

  it('成功：deleteSessionLocal → markDeleted → remove/clear → close(best effort) → finalize，返回 ok', async () => {
    const { deps, calls } = createDeps()
    const result = await removeSessionTransaction('s1', deps)
    expect(result).toEqual({ ok: true, value: 's1' })
    expect(calls).toEqual(['delete:s1@peri', 'markDeleted:s1', 'remove:s1', 'clear:s1', 'close:local:x@peri', 'finalize:s1@local:x'])
  })

  it('本地删除失败：不 remove/clear，不 close/finalize（本地会话保留可重试），返回 transport', async () => {
    const { deps, calls } = createDeps({
      deleteSessionLocal: async () => { throw new Error('user_session_delete failed') },
    })
    const result = await removeSessionTransaction('s1', deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('transport')
    expect(calls).toEqual([])
    expect(deps.reportError).toHaveBeenCalledWith('删除会话记录', expect.any(Error))
  })

  it('本地删除失败：markSessionDeleted 不得调用（会话保留，未到删除终态）', async () => {
    const { deps, calls } = createDeps({
      deleteSessionLocal: async () => { throw new Error('boom') },
    })
    const result = await removeSessionTransaction('s1', deps)
    expect(result.ok).toBe(false)
    expect(calls.filter(call => call.startsWith('markDeleted:'))).toEqual([])
  })

  it('远端 close 失败：本地删除成功不回滚（remove/clear 已执行），close 仅报告，返回 ok', async () => {
    const { deps, calls } = createDeps({
      closeSession: async () => { throw new Error('close failed') },
    })
    const result = await removeSessionTransaction('s1', deps)
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['delete:s1@peri', 'markDeleted:s1', 'remove:s1', 'clear:s1', 'finalize:s1@local:x'])
    expect(deps.reportError).toHaveBeenCalledWith('关闭会话', expect.any(Error))
  })

  it('finalize 失败：本地删除已完成，finalize 仅报告，返回 ok', async () => {
    const { deps, calls } = createDeps({
      finalizeSessionDelete: async () => { throw new Error('finalize failed') },
    })
    const result = await removeSessionTransaction('s1', deps)
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['delete:s1@peri', 'markDeleted:s1', 'remove:s1', 'clear:s1', 'close:local:x@peri'])
    expect(deps.reportError).toHaveBeenCalledWith('确认删除', expect.any(Error))
  })

  it('会话不存在：validation 失败，不调任何删除/close', async () => {
    const { deps, calls } = createDeps()
    const result = await removeSessionTransaction('missing', deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('validation')
    expect(calls).toEqual([])
  })

  it('duplicate：删除成功后再次删除 → validation（幂等不重复删除）', async () => {
    let exists = true
    const { deps, calls } = createDeps({
      findSession: () => (exists ? SESSION : undefined),
      removeSession: () => { exists = false },
    })
    const first = await removeSessionTransaction('s1', deps)
    expect(first.ok).toBe(true)
    // 第二次：session 已不存在 → validation，删除不重复调用
    const second = await removeSessionTransaction('s1', deps)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.kind).toBe('validation')
    expect(calls.filter(call => call.startsWith('delete:')).length).toBe(1)
  })
})
