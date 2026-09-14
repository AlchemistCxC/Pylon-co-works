import { describe, expect, it } from 'vitest'
import {
  activeForAgent,
  EMPTY_PERMISSION_STATE,
  emptyAgentSlice,
  permissionReducer,
  sliceForAgent,
  type PermissionAgentSlice,
  type PermissionState,
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

// ── 迁移自 scripts/test-permission-state.mts（P91 A1）──
// P0-01：权限请求纯状态机——每个 request 只应答一次；FIFO 队列；options 顺序与 optionId 原值

const legacyReq = (requestId: string, options: string[]): PermissionRequest => ({
  // P1-1：receive 无 agentId 的请求不进状态——fixture 必须带 agentId 才能挂起
  agentId: 'peri-a',
  requestId,
  provider: 'peri',
  sessionId: 's1',
  clientGeneration: 1,
  options: options.map(optionId => ({ optionId })),
})

const legacyRcv = (request: PermissionRequest) => permissionReducer(EMPTY_PERMISSION_STATE, { type: 'receive', request, now: 0 })
const legacySlice = (state: PermissionState): PermissionAgentSlice => state.byAgent['peri-a'] ?? { active: null, queued: [] }

describe('permissionState 状态机守卫（迁移自 scripts/test-permission-state.mts，P91 A1）', () => {
  it('1. 2/5 options：接收后 active 置 pending，options 顺序与 optionId 原值保留', () => {
    const two = legacyRcv(legacyReq('1', ['allow_once', 'reject_once']))
    expect(legacySlice(two).active?.request.requestId).toBe('1')
    expect(legacySlice(two).active?.status).toBe('pending')
    expect(legacySlice(two).active?.request.options.map(o => o.optionId)).toEqual(['allow_once', 'reject_once'])

    const five = legacyRcv(legacyReq('2', ['allow_once', 'allow_session', 'allow_always', 'deny', 'deny_always']))
    expect(legacySlice(five).active?.request.options.map(o => o.optionId)).toEqual(['allow_once', 'allow_session', 'allow_always', 'deny', 'deny_always'])
  })

  it('2. FIFO：active 占用时入队；settle 后弹出队首', () => {
    const a = permissionReducer(legacyRcv(legacyReq('1', ['allow_once', 'reject_once'])), { type: 'receive', request: legacyReq('2', ['allow_once', 'deny']), now: 1 })
    expect(legacySlice(a).active?.request.requestId).toBe('1')
    expect(legacySlice(a).queued.length).toBe(1)
    expect(legacySlice(a).queued[0].request.requestId).toBe('2')
    const settled = permissionReducer(a, { type: 'choose', agentId: 'peri-a', requestId: '1', optionId: 'allow_once' })
    const popped = permissionReducer(settled, { type: 'resolve', agentId: 'peri-a', requestId: '1', ok: true })
    expect(legacySlice(popped).active?.request.requestId).toBe('2') // settle 后队首成为下一 active
    expect(legacySlice(popped).queued.length).toBe(0)
  })

  it('3. 重复点击：第二次 choose 无操作（状态保持 answering、chosenOptionId 不变）', () => {
    const chosen = permissionReducer(legacyRcv(legacyReq('1', ['allow_once', 'reject_once'])), { type: 'choose', agentId: 'peri-a', requestId: '1', optionId: 'reject_once' })
    expect(legacySlice(chosen).active?.status).toBe('answering')
    expect(legacySlice(chosen).active?.chosenOptionId).toBe('reject_once')
    const doubleClick = permissionReducer(chosen, { type: 'choose', agentId: 'peri-a', requestId: '1', optionId: 'allow_once' })
    expect(legacySlice(doubleClick)).toBe(legacySlice(chosen)) // 第二次 choose 必须无操作（引用相等）
  })

  it('4. 300s timeout：active pending → timed-out，弹出队首', () => {
    const t1 = permissionReducer(legacyRcv(legacyReq('1', ['allow_once', 'reject_once'])), { type: 'receive', request: legacyReq('2', ['deny']), now: 1 })
    const timedOut = permissionReducer(t1, { type: 'timeout', agentId: 'peri-a', requestId: '1' })
    expect(legacySlice(timedOut).active?.request.requestId).toBe('2') // timeout 后弹出队首
    expect(legacySlice(timedOut).active?.status).toBe('pending')
  })

  it('5. 迟到 resolve（请求已 timeout 被弹出）→ 无操作', () => {
    const t1 = permissionReducer(legacyRcv(legacyReq('1', ['allow_once', 'reject_once'])), { type: 'receive', request: legacyReq('2', ['deny']), now: 1 })
    const timedOut = permissionReducer(t1, { type: 'timeout', agentId: 'peri-a', requestId: '1' })
    const lateResolve = permissionReducer(timedOut, { type: 'resolve', agentId: 'peri-a', requestId: '1', ok: true })
    expect(legacySlice(lateResolve)).toBe(legacySlice(timedOut)) // 迟到 resolve 必须无操作（引用相等）
  })

  it('6. receive 去重：同 requestId 已在 active/queued → 无操作', () => {
    const dup = permissionReducer(legacyRcv(legacyReq('1', ['allow_once'])), { type: 'receive', request: legacyReq('1', ['allow_once']), now: 2 })
    expect(legacySlice(dup).active?.request.options.length).toBe(1)
    expect(legacySlice(dup).queued.length).toBe(0)
  })

  it('7. choose 未知 optionId → 无操作（不伪造 optionId）', () => {
    const unknownOption = permissionReducer(legacyRcv(legacyReq('1', ['allow_once'])), { type: 'choose', agentId: 'peri-a', requestId: '1', optionId: 'not-an-option' })
    expect(legacySlice(unknownOption).active?.status).toBe('pending')
  })

  it('8. resolve 失败 → 回 pending 记录 lastError，可换 option 重试', () => {
    const fail = permissionReducer(legacyRcv(legacyReq('1', ['allow_once', 'deny'])), { type: 'choose', agentId: 'peri-a', requestId: '1', optionId: 'allow_once' })
    const failed = permissionReducer(fail, { type: 'resolve', agentId: 'peri-a', requestId: '1', ok: false, error: 'protocol_error' })
    expect(legacySlice(failed).active?.status).toBe('pending')
    expect(legacySlice(failed).active?.lastError).toBe('protocol_error')
    expect(legacySlice(failed).active?.chosenOptionId).toBeUndefined() // 重试前清掉旧选择
    const retry = permissionReducer(failed, { type: 'choose', agentId: 'peri-a', requestId: '1', optionId: 'deny' })
    expect(legacySlice(retry).active?.status).toBe('answering')
    expect(legacySlice(retry).active?.chosenOptionId).toBe('deny')
  })

  it('9. reject（本地 settle，不 invoke）→ 弹出队首', () => {
    const rejected = permissionReducer(
      permissionReducer(legacyRcv(legacyReq('1', ['allow_once'])), { type: 'receive', request: legacyReq('2', ['deny']), now: 1 }),
      { type: 'reject', agentId: 'peri-a', requestId: '1' },
    )
    expect(legacySlice(rejected).active?.request.requestId).toBe('2')
  })

  it('10. clear → 全部清空', () => {
    const cleared = permissionReducer(
      permissionReducer(legacyRcv(legacyReq('1', ['allow_once'])), { type: 'receive', request: legacyReq('2', ['deny']), now: 1 }),
      { type: 'clear' },
    )
    expect(legacySlice(cleared).active).toBeNull()
    expect(legacySlice(cleared).queued.length).toBe(0)
  })

  it('11. 对不存在的 requestId 操作全部无操作', () => {
    expect(permissionReducer(EMPTY_PERMISSION_STATE, { type: 'timeout', agentId: 'peri-a', requestId: '99' })).toBe(EMPTY_PERMISSION_STATE)
    expect(legacySlice(permissionReducer(legacyRcv(legacyReq('1', ['allow_once'])), { type: 'resolve', agentId: 'peri-a', requestId: '99', ok: true })).active?.request.requestId).toBe('1')
  })
})
