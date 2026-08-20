import { strict as assert } from 'node:assert'
import { permissionReducer, EMPTY_PERMISSION_STATE, type PermissionAgentSlice, type PermissionRequest, type PermissionState } from '../src/domains/permission/permissionState.ts'

// P0-01：权限请求纯状态机——每个 request 只应答一次；FIFO 队列；options 顺序与 optionId 原值

const req = (requestId: string, options: string[]): PermissionRequest => ({
  // P1-1：receive 无 agentId 的请求不进状态——fixture 必须带 agentId 才能挂起
  agentId: 'peri-a',
  requestId,
  options: options.map(optionId => ({ optionId })),
})

const rcv = (request: PermissionRequest) => permissionReducer(EMPTY_PERMISSION_STATE, { type: 'receive', request, now: 0 })
const slice = (state: PermissionState): PermissionAgentSlice => state.byAgent['peri-a'] ?? { active: null, queued: [] }

// 1. 2/5 options：接收后 active 置 pending，options 顺序与 optionId 原值保留
const two = rcv(req('1', ['allow_once', 'reject_once']))
assert.equal(slice(two).active?.request.requestId, '1')
assert.equal(slice(two).active?.status, 'pending')
assert.deepEqual(slice(two).active?.request.options.map(o => o.optionId), ['allow_once', 'reject_once'])

const five = rcv(req('2', ['allow_once', 'allow_session', 'allow_always', 'deny', 'deny_always']))
assert.deepEqual(slice(five).active?.request.options.map(o => o.optionId), ['allow_once', 'allow_session', 'allow_always', 'deny', 'deny_always'])

// 2. FIFO：active 占用时入队；settle 后弹出队首
const a = permissionReducer(rcv(req('1', ['allow_once', 'reject_once'])), { type: 'receive', request: req('2', ['allow_once', 'deny']), now: 1 })
assert.equal(slice(a).active?.request.requestId, '1')
assert.equal(slice(a).queued.length, 1)
assert.equal(slice(a).queued[0].request.requestId, '2')
const settled = permissionReducer(a, { type: 'choose', agentId: 'peri-a', requestId: '1', optionId: 'allow_once' })
const popped = permissionReducer(settled, { type: 'resolve', agentId: 'peri-a', requestId: '1', ok: true })
assert.equal(slice(popped).active?.request.requestId, '2', 'settle 后队首成为下一 active')
assert.equal(slice(popped).queued.length, 0)

// 3. 重复点击：第二次 choose 无操作（状态保持 answering、chosenOptionId 不变）
const chosen = permissionReducer(rcv(req('1', ['allow_once', 'reject_once'])), { type: 'choose', agentId: 'peri-a', requestId: '1', optionId: 'reject_once' })
assert.equal(slice(chosen).active?.status, 'answering')
assert.equal(slice(chosen).active?.chosenOptionId, 'reject_once')
const doubleClick = permissionReducer(chosen, { type: 'choose', agentId: 'peri-a', requestId: '1', optionId: 'allow_once' })
assert.equal(slice(doubleClick), slice(chosen), '第二次 choose 必须无操作（引用相等）')

// 4. 300s timeout：active pending → timed-out，弹出队首
const t1 = permissionReducer(rcv(req('1', ['allow_once', 'reject_once'])), { type: 'receive', request: req('2', ['deny']), now: 1 })
const timedOut = permissionReducer(t1, { type: 'timeout', agentId: 'peri-a', requestId: '1' })
assert.equal(slice(timedOut).active?.request.requestId, '2', 'timeout 后弹出队首')
assert.equal(slice(timedOut).active?.status, 'pending')

// 5. 迟到 resolve（请求已 timeout 被弹出）→ 无操作
const lateResolve = permissionReducer(timedOut, { type: 'resolve', agentId: 'peri-a', requestId: '1', ok: true })
assert.equal(slice(lateResolve), slice(timedOut), '迟到 resolve 必须无操作（引用相等）')

// 6. receive 去重：同 requestId 已在 active/queued → 无操作
const dup = permissionReducer(rcv(req('1', ['allow_once'])), { type: 'receive', request: req('1', ['allow_once']), now: 2 })
assert.equal(slice(dup).active?.request.options.length, 1)
assert.equal(slice(dup).queued.length, 0)

// 7. choose 未知 optionId → 无操作（不伪造 optionId）
const unknownOption = permissionReducer(rcv(req('1', ['allow_once'])), { type: 'choose', agentId: 'peri-a', requestId: '1', optionId: 'not-an-option' })
assert.equal(slice(unknownOption).active?.status, 'pending')

// 8. resolve 失败 → 回 pending 记录 lastError，可换 option 重试
const fail = permissionReducer(rcv(req('1', ['allow_once', 'deny'])), { type: 'choose', agentId: 'peri-a', requestId: '1', optionId: 'allow_once' })
const failed = permissionReducer(fail, { type: 'resolve', agentId: 'peri-a', requestId: '1', ok: false, error: 'protocol_error' })
assert.equal(slice(failed).active?.status, 'pending')
assert.equal(slice(failed).active?.lastError, 'protocol_error')
assert.equal(slice(failed).active?.chosenOptionId, undefined, '重试前清掉旧选择')
const retry = permissionReducer(failed, { type: 'choose', agentId: 'peri-a', requestId: '1', optionId: 'deny' })
assert.equal(slice(retry).active?.status, 'answering')
assert.equal(slice(retry).active?.chosenOptionId, 'deny')

// 9. reject（本地 settle，不 invoke）→ 弹出队首
const rejected = permissionReducer(
  permissionReducer(rcv(req('1', ['allow_once'])), { type: 'receive', request: req('2', ['deny']), now: 1 }),
  { type: 'reject', agentId: 'peri-a', requestId: '1' },
)
assert.equal(slice(rejected).active?.request.requestId, '2')

// 10. clear → 全部清空
const cleared = permissionReducer(
  permissionReducer(rcv(req('1', ['allow_once'])), { type: 'receive', request: req('2', ['deny']), now: 1 }),
  { type: 'clear' },
)
assert.equal(slice(cleared).active, null)
assert.equal(slice(cleared).queued.length, 0)

// 11. 对不存在的 requestId 操作全部无操作
assert.equal(permissionReducer(EMPTY_PERMISSION_STATE, { type: 'timeout', agentId: 'peri-a', requestId: '99' }), EMPTY_PERMISSION_STATE)
assert.equal(slice(permissionReducer(rcv(req('1', ['allow_once'])), { type: 'resolve', agentId: 'peri-a', requestId: '99', ok: true })).active?.request.requestId, '1')

console.log('permission state 状态机守卫通过')
