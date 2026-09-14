// 迁移自 scripts/test-agent-status-transaction.mts（P91 A1）；App/Settings/runtimeStore 源码 include 段按处置不迁。
import { describe, expect, it } from 'vitest'
import { beginReconnect, completeReconnect, failReconnect, normalizeAgentList } from '../agentState.ts'

describe('agentState — 重连事务与列表归一（迁移自 scripts/test-agent-status-transaction.mts，P91 A1）', () => {
  it('begin/complete/failReconnect 状态转移', () => {
    const initial = { status: 'connected' as const, pending: false }
    expect(beginReconnect(initial).status).toBe('reconnecting')
    expect(completeReconnect(beginReconnect(initial)).status).toBe('connected')
    expect(failReconnect(beginReconnect(initial), '失败').error).toBe('失败')
  })

  it('normalizeAgentList 过滤非结构化条目与非数组输入', () => {
    expect(normalizeAgentList([{ id: 'peri', name: 'Peri' }, { id: 1, name: 'bad' }, null])).toEqual([{ id: 'peri', name: 'Peri' }])
    expect(normalizeAgentList({ agents: [] })).toEqual([])
  })
})
