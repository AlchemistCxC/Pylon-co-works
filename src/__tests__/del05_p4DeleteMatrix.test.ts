/**
 * DEL-05：P4 幂等/断线/重试矩阵（方案书任务表 DEL-05——测试卡，依赖 DEL-02~04）。
 *
 * 组合交易 + 错误码归一化，锁定 P4 核心行为（§5.13）：
 * 1. 幂等重试：删除首败（code=message_db_unavailable）返回 transport、本地会话保留、
 *    未到删除终态（不 markDeleted）；重试成功 → markDeleted + 清理 + close/finalize。
 * 2. 断线：远端 close 失败（code=agent_unavailable，测试模拟码——DEL-05 CR-002 消化，
 *    非稳定 wire_code 契约成员）不阻断本地删除（本地优先），错误可见且结构化 code 保留。
 * 3. 调度器 terminal/迟到写语义：A1-c 后 messages 表已停写，相关覆盖由
 *    canonicalEventPersistScheduler.test 承接（event_revision_conflict/event_invalid 丢弃、
 *    discard 后不复活）。
 */
import { describe, expect, it, vi } from 'vitest'
import { MessageRepositoryError } from '../components/chat/messagePersistence'
import { removeSessionTransaction } from '../application/transactions/removeSessionTransaction'
import type { Session } from '../identityStore'

const SESSION: Session = {
  id: 's1', agentId: 'peri', name: '会话一', source: 'local:x', profileId: 'p', createdAt: 0,
  lastActiveAt: 0, platform: 'local', workdir: '', sessionPrompt: '',
  skills: [], hooks: [], autoName: '',
}

describe('P4 幂等/断线/重试矩阵（DEL-05）', () => {

  it('矩阵-幂等重试：删除首败（message_db_unavailable）不清理可重试；重试成功 → markDeleted+清理', async () => {
    let attempts = 0
    const calls: string[] = []
    const reportError = vi.fn()
    const deps = {
      findSession: (id: string) => (id === SESSION.id ? SESSION : undefined),
      deleteSessionLocal: async () => {
        attempts += 1
        if (attempts === 1) throw new MessageRepositoryError('message_db_unavailable', 'db down')
        calls.push('delete:s1')
      },
      markSessionDeleted: (id: string) => { calls.push(`markDeleted:${id}`) },
      closeSession: async () => { calls.push('close:s1') },
      finalizeSessionDelete: async () => { calls.push('finalize:s1') },
      removeSession: (id: string) => { calls.push(`remove:${id}`) },
      clearMessages: (id: string) => { calls.push(`clear:${id}`) },
      reportError,
    }

    const first = await removeSessionTransaction('s1', deps)
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.kind).toBe('transport')
    expect(reportError).toHaveBeenCalledWith('删除会话记录', expect.any(MessageRepositoryError))
    // 首败：未到删除终态——markDeleted/remove/clear/close/finalize 一律不得执行
    expect(calls).toEqual([])

    const second = await removeSessionTransaction('s1', deps)
    expect(second.ok).toBe(true)
    expect(calls).toEqual(['delete:s1', 'markDeleted:s1', 'remove:s1', 'clear:s1', 'close:s1', 'finalize:s1'])
  })

  it('矩阵-断线：远端 close 失败（agent_unavailable）→ 本地删除仍 ok，错误可见且 code 保留', async () => {
    // agent_unavailable 为测试模拟码（DEL-05 CR-002 消化：非稳定 wire_code 契约成员，
    // 仅用于本矩阵模拟远端不可达；不得进入 LOG-03 RuntimeLogEntry.code 生产值域）。
    const closeError = new MessageRepositoryError('agent_unavailable', 'agent offline')
    const reportError = vi.fn()
    const deps = {
      findSession: (id: string) => (id === SESSION.id ? SESSION : undefined),
      deleteSessionLocal: async () => {},
      markSessionDeleted: vi.fn(),
      closeSession: async () => { throw closeError },
      finalizeSessionDelete: async () => {},
      removeSession: vi.fn(),
      clearMessages: vi.fn(),
      reportError,
    }

    const result = await removeSessionTransaction('s1', deps)
    expect(result.ok).toBe(true)
    // 本地删除成功即完成：markDeleted + UI 清理不受远端失败影响
    expect(deps.markSessionDeleted).toHaveBeenCalledWith('s1')
    expect(deps.removeSession).toHaveBeenCalledWith('s1')
    expect(deps.clearMessages).toHaveBeenCalledWith('s1')
    // 远端失败可见且结构化 code 保留（B1.2 wire 契约）
    expect(reportError).toHaveBeenCalledWith('关闭会话', closeError)
    expect(closeError.code).toBe('agent_unavailable')
  })
})
