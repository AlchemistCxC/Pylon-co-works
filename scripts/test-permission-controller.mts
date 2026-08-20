import { strict as assert } from 'node:assert'
import {
  createPermissionController,
  normalizePermissionRequest,
  resolveTimeoutDenyOption,
  type PermissionControllerDeps,
} from '../src/infrastructure/acp/permissionController.ts'
import { permissionReducer, EMPTY_PERMISSION_STATE, type PermissionAction, type PermissionState } from '../src/domains/permission/permissionState.ts'

const wirePayload = (requestId: number, options: string[]) => ({
  provider: 'peri',
  agentId: 'peri',
  sessionId: 's1',
  eventType: 'permission.request',
  requestId: String(requestId),
  toolCallId: 't1',
  clientGeneration: 3,
  payload: {
    title: '工具调用', prompt: '允许执行？', requestedAt: 123,
    // ACP-03（§5.6）：deadline 由后端单一来源给出（PERMISSION_REQUEST_TIMEOUT_SECS）
    deadlineMs: 123 + 300_000,
    options: options.map(optionId => ({ optionId })),
  },
})

// ACP-03（§5.6）：后端唯一计时/应答——permission.resolved terminal 事件载荷。
const resolvedEvent = (requestId: string, clientGeneration?: number) => ({
  provider: 'peri',
  agentId: 'peri',
  sessionId: 's1',
  eventType: 'permission.resolved',
  requestId,
  clientGeneration,
  optionId: 'reject_once',
  reason: 'timed_out',
})

interface Harness {
  controller: ReturnType<typeof createPermissionController>
  actions: PermissionAction[]
  invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }>
  stopCalled: boolean
  state: () => PermissionState
  receive: (requestId?: number, options?: string[]) => void
  emitResolved: (requestId: string, clientGeneration?: number) => void
}

function setup(options: string[], invokeImpl?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>): Harness {
  let state: PermissionState = EMPTY_PERMISSION_STATE
  const actions: PermissionAction[] = []
  const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = []
  let stopCalled = false
  let handler: ((event: { payload: unknown }) => void) | null = null
  const deps: PermissionControllerDeps = {
    dispatch: action => { actions.push(action); state = permissionReducer(state, action) },
    getState: () => state,
    // P1-1：脚本 wirePayload 的 agentId 为 'peri'——controller 作用在该 agent 切片
    getCurrentAgentId: () => 'peri',
    listen: (event, h) => { assert.equal(event, 'pylon:interaction'); handler = h as typeof handler; return Promise.resolve(() => { stopCalled = true }) },
    invoke: async (cmd, args) => {
      invokeCalls.push({ cmd, args: args as Record<string, unknown> })
      if (invokeImpl) return invokeImpl(cmd, args as Record<string, unknown>)
      return null
    },
    now: () => 1000,
  }
  const controller = createPermissionController(deps)
  const receive = (requestId = 1, opts = options) => { assert.ok(handler); handler!({ payload: wirePayload(requestId, opts) }) }
  const emitResolved = (requestId: string, clientGeneration?: number) => { assert.ok(handler); handler!({ payload: resolvedEvent(requestId, clientGeneration) }) }
  return { controller, actions, invokeCalls, get stopCalled() { return stopCalled }, state: () => state, receive, emitResolved }
}

// ACP-03（§5.6）：前端不再持有超时 timer——receive 只入状态，不创建 timer。
{
  const h = setup(['allow_once', 'reject_once'])
  h.receive()
  assert.equal(h.actions[0]?.type, 'receive')
}
{
  const h = setup(['allow_once', 'reject_once'])
  h.receive()
  await h.controller.choose('1', 'allow_once')
  assert.deepEqual(h.invokeCalls[0], {
    cmd: 'respond_interaction',
    args: {
      identity: { provider: 'peri', agentId: 'peri', requestId: '1', sessionId: 's1', toolCallId: 't1', clientGeneration: 3 },
      kind: 'approval', answer: { optionId: 'allow_once' },
    },
  })
}
{
  const h = setup(['allow_once', 'deny'], async () => { throw new Error('protocol_error') })
  h.receive(); await h.controller.choose('1', 'allow_once')
  assert.equal(h.actions.at(-1)?.type, 'resolve')
  assert.equal(h.actions.at(-1)?.ok, false)
}
// ACP-03（§5.6）：超时由后端唯一判定——permission.resolved 命中 active → settle，
// 前端不得自行 invoke（invariant 5：不宣称 agent 已收到 response）。
{
  const h = setup(['allow_once', 'reject_once'])
  h.receive()
  h.emitResolved('1', 3)
  assert.equal(h.invokeCalls.length, 0, '超时 settle 不得触发前端 invoke')
  const last = h.actions.at(-1)
  assert.equal(last?.type, 'resolve')
  assert.equal(last?.ok, true)
  assert.equal((last as { clientGeneration?: number }).clientGeneration, 3)
  assert.equal(h.state().byAgent.peri.active, null, '超时 settle 后 active 弹出')
}
// ACP-03：permission.resolved 命中 queued（非 active）请求——只从队列移除，不动 active。
{
  const h = setup(['allow_once', 'reject_once'])
  h.receive(1)
  h.receive(2)
  assert.equal(h.state().byAgent.peri.queued.length, 1, '第二请求必须入队')
  h.emitResolved('2', 3)
  assert.equal(h.state().byAgent.peri.queued.length, 0, 'queued 超时条目必须移除')
  assert.equal(h.state().byAgent.peri.active?.request.requestId, '1', 'active 不受影响')
}
{
  const h = setup(['allow_once']); h.receive(); await h.controller.dispose()
  assert.equal(h.stopCalled, true); assert.equal(h.invokeCalls.length, 0)
}

assert.equal(normalizePermissionRequest(null), null)
assert.equal(normalizePermissionRequest({ requestId: 1, options: [{ optionId: 'x' }] }), null)
assert.equal(normalizePermissionRequest(wirePayload(7, ['allow_once']))?.requestId, '7')
// ACP-03：deadlineMs 透传（后端单一来源，前端只读展示）。
assert.equal(normalizePermissionRequest(wirePayload(9, ['allow_once']))?.deadlineMs, 123 + 300_000)
// WI-04 CR-001 吸收：requestedAt 字符串分支（Rust Timestamp 字符串 wire）
const strAt = normalizePermissionRequest({
  ...wirePayload(8, ['allow_once']),
  payload: { ...wirePayload(8, ['allow_once']).payload, requestedAt: '2026-08-13T00:00:00Z' },
})
assert.equal(strAt?.requestedAt, '2026-08-13T00:00:00Z')
assert.equal(resolveTimeoutDenyOption([{ optionId: 'allow_once' }, { optionId: 'reject_once' }])?.optionId, 'reject_once')
console.log('permission controller interaction transport mock 守卫通过')
