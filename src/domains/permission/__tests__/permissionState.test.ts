import { describe, expect, it } from 'vitest'
import {
  activeForAgent,
  EMPTY_PERMISSION_STATE,
  emptyAgentSlice,
  permissionReducer,
  sliceForAgent,
} from '../permissionState.ts'
import type { PermissionRequest } from '../permissionTypes.ts'

function request(agentId: string, requestId: string, overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId,
    provider: 'peri',
    agentId,
    sessionId: 's1',
    clientGeneration: 1,
    options: [{ optionId: 'allow_once' }, { optionId: 'reject_once' }],
    ...overrides,
  }
}

describe('permissionState 按 agent 切片隔离（P1-1）', () => {
  it('同 provider 两个 agentId 的请求各自 active，不串槽', () => {
    let state = EMPTY_PERMISSION_STATE
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '1') })
    state = permissionReducer(state, { type: 'receive', request: request('peri-b', '2') })
    expect(activeForAgent(state, 'peri-a')?.request.requestId).toBe('1')
    expect(activeForAgent(state, 'peri-b')?.request.requestId).toBe('2')
  })

  it('同 agent 队列 FIFO：settle 后弹出队首', () => {
    let state = EMPTY_PERMISSION_STATE
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '1') })
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '2') })
    expect(activeForAgent(state, 'peri-a')?.request.requestId).toBe('1')
    state = permissionReducer(state, { type: 'resolve', agentId: 'peri-a', requestId: '1', ok: true })
    expect(activeForAgent(state, 'peri-a')?.request.requestId).toBe('2')
  })

  it('A 的队列不因 B 的 resolve 变化（严格隔离）', () => {
    let state = EMPTY_PERMISSION_STATE
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '1') })
    state = permissionReducer(state, { type: 'receive', request: request('peri-b', '2') })
    state = permissionReducer(state, { type: 'resolve', agentId: 'peri-b', requestId: '2', ok: true })
    expect(activeForAgent(state, 'peri-a')?.request.requestId).toBe('1')
    expect(activeForAgent(state, 'peri-b')).toBeNull()
  })

  it('防双答：同 requestId 第二次 choose 无操作', () => {
    let state = EMPTY_PERMISSION_STATE
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '1') })
    state = permissionReducer(state, { type: 'choose', agentId: 'peri-a', requestId: '1', optionId: 'allow_once' })
    const answering = state.byAgent['peri-a']?.active?.status
    state = permissionReducer(state, { type: 'choose', agentId: 'peri-a', requestId: '1', optionId: 'allow_once' })
    expect(state.byAgent['peri-a']?.active?.status).toBe(answering)
  })

  it('invoke 失败 resolve ok:false 回 pending 并记 lastError（可重试）', () => {
    let state = EMPTY_PERMISSION_STATE
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '1') })
    state = permissionReducer(state, { type: 'choose', agentId: 'peri-a', requestId: '1', optionId: 'allow_once' })
    state = permissionReducer(state, { type: 'resolve', agentId: 'peri-a', requestId: '1', ok: false, error: 'down' })
    const active = state.byAgent['peri-a']?.active
    expect(active?.status).toBe('pending')
    expect(active?.lastError).toBe('down')
    expect(active?.chosenOptionId).toBeUndefined()
  })

  it('timeout/reject 只 settle 指定 agent 的 pending active', () => {
    let state = EMPTY_PERMISSION_STATE
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '1') })
    state = permissionReducer(state, { type: 'receive', request: request('peri-b', '2') })
    state = permissionReducer(state, { type: 'timeout', agentId: 'peri-a', requestId: '1' })
    expect(activeForAgent(state, 'peri-a')).toBeNull()
    expect(activeForAgent(state, 'peri-b')?.request.requestId).toBe('2')
    state = permissionReducer(state, { type: 'reject', agentId: 'peri-b', requestId: '2' })
    expect(activeForAgent(state, 'peri-b')).toBeNull()
  })

  it('receive 无 agentId 的请求不进状态（未知请求不可占槽）', () => {
    const state = permissionReducer(EMPTY_PERMISSION_STATE, {
      type: 'receive',
      request: request('', '1'),
    })
    expect(state.byAgent['']).toBeUndefined()
    expect(Object.keys(state.byAgent)).toHaveLength(0)
  })

  it('clear-agent 只清指定 agent；clear 全清', () => {
    let state = EMPTY_PERMISSION_STATE
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '1') })
    state = permissionReducer(state, { type: 'receive', request: request('peri-b', '2') })
    state = permissionReducer(state, { type: 'clear-agent', agentId: 'peri-a' })
    expect(activeForAgent(state, 'peri-a')).toBeNull()
    expect(activeForAgent(state, 'peri-b')?.request.requestId).toBe('2')
    state = permissionReducer(state, { type: 'clear' })
    expect(state.byAgent).toEqual({})
  })

  it('selectors：sliceForAgent 缺省空切片，activeForAgent 无则 null', () => {
    expect(sliceForAgent(EMPTY_PERMISSION_STATE, 'nobody')).toEqual(emptyAgentSlice())
    expect(activeForAgent(EMPTY_PERMISSION_STATE, 'nobody')).toBeNull()
  })

  it('stale generation：更高代到达清掉旧代切片条目（客户端替换，Phase E #4）', () => {
    let state = EMPTY_PERMISSION_STATE
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '1', { clientGeneration: 1 }) })
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '2', { clientGeneration: 1 }) })
    expect(activeForAgent(state, 'peri-a')?.request.requestId).toBe('1')
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '3', { clientGeneration: 2 }) })
    // 旧代 1/2 全部失效，新代 3 成为 active
    expect(activeForAgent(state, 'peri-a')?.request.requestId).toBe('3')
    expect(sliceForAgent(state, 'peri-a').queued).toHaveLength(0)
  })

  it('stale generation：更低代（迟到旧客户端）请求被丢弃', () => {
    let state = EMPTY_PERMISSION_STATE
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '5', { clientGeneration: 2 }) })
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '4', { clientGeneration: 1 }) })
    expect(activeForAgent(state, 'peri-a')?.request.requestId).toBe('5')
    expect(sliceForAgent(state, 'peri-a').queued).toHaveLength(0)
  })

  it('重连后同 requestId 不同 generation：新客户端请求不被误当重复丢弃', () => {
    // 新客户端从低 id 重新编号，与停放的同 agent 旧代请求 requestId 撞车——
    // 去重必须是 (requestId, clientGeneration) 双键（WI-06 玉衡边界发现）
    let state = EMPTY_PERMISSION_STATE
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '0', { clientGeneration: 1 }) })
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '0', { clientGeneration: 2 }) })
    expect(activeForAgent(state, 'peri-a')?.request.requestId).toBe('0')
    expect(activeForAgent(state, 'peri-a')?.request.clientGeneration).toBe(2)
    // 同 requestId + 同 generation 仍正确去重
    state = permissionReducer(state, { type: 'receive', request: request('peri-a', '0', { clientGeneration: 2 }) })
    expect(activeForAgent(state, 'peri-a')?.request.clientGeneration).toBe(2)
    expect(sliceForAgent(state, 'peri-a').queued).toHaveLength(0)
  })
})
