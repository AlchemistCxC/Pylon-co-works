import { strict as assert } from 'node:assert'
import {
  createPermissionController,
  normalizePermissionRequest,
  resolveTimeoutDenyOption,
  PERMISSION_TIMEOUT_MS,
  type PermissionControllerDeps,
} from '../src/infrastructure/acp/permissionController.ts'
import { permissionReducer, EMPTY_PERMISSION_STATE, type PermissionAction, type PermissionState } from '../src/domains/permission/permissionState.ts'

// P0-02：permission controller mock 全链路——注入 listen/invoke/timer/store，不依赖 Tauri runtime

class FakeTimer {
  private nextId = 1
  private handles = new Map<number, { fn: () => void; cleared: boolean }>()
  set(fn: () => void) { const id = this.nextId++; this.handles.set(id, { fn, cleared: false }); return id }
  clear(id: number) { const h = this.handles.get(id); if (h) h.cleared = true }
  fire(id: number) { const h = this.handles.get(id); if (!h || h.cleared) return; h.fn() }
  activeCount() { return [...this.handles.values()].filter(h => !h.cleared).length }
  ids() { return [...this.handles.keys()] }
}

const wirePayload = (requestId: number, options: string[]) => ({
  requestId,
  sessionId: 's1',
  toolCallId: 't1',
  title: '工具调用',
  prompt: '允许执行？',
  requestedAt: 123,
  options: options.map(optionId => ({ optionId })),
})

interface Harness {
  controller: ReturnType<typeof createPermissionController>
  actions: PermissionAction[]
  invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }>
  timer: FakeTimer
  stopCalled: boolean
  fire: () => number
}

function setup(options: string[], invokeImpl?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>): Harness {
  let state: PermissionState = EMPTY_PERMISSION_STATE
  const actions: PermissionAction[] = []
  const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = []
  const timer = new FakeTimer()
  let stopCalled = false
  let handler: ((event: { payload: unknown }) => void) | null = null
  const deps: PermissionControllerDeps = {
    dispatch: action => { actions.push(action); state = permissionReducer(state, action) },
    getState: () => state,
    listen: (event, h) => { assert.equal(event, 'pylon:permission-request'); handler = h as typeof handler; return Promise.resolve(() => { stopCalled = true }) },
    invoke: async (cmd, args) => {
      invokeCalls.push({ cmd, args: args as Record<string, unknown> })
      if (invokeImpl) return invokeImpl(cmd, args as Record<string, unknown>)
      return null
    },
    setTimeoutFn: fn => timer.set(fn),
    clearTimeoutFn: id => timer.clear(id as number),
    now: () => 1000,
  }
  const controller = createPermissionController(deps)
  const receive = () => {
    assert.ok(handler, 'listener 必须已注册')
    handler!({ payload: wirePayload(1, options) })
  }
  return {
    controller,
    actions,
    invokeCalls,
    timer,
    get stopCalled() { return stopCalled },
    fire: () => { const ids = timer.ids(); if (ids.length === 0) throw new Error('no timer'); timer.fire(ids[0]); return ids[0] },
    receive,
  }
}

// 1. 事件注入 → receive dispatch + store active
{
  const h = setup(['allow_once', 'reject_once'])
  h.receive()
  assert.equal(h.actions[0]?.type, 'receive')
  assert.equal(h.actions[0]?.request.requestId, 1)
  assert.equal(h.timer.activeCount(), 1, 'active pending 必须挂 300s 超时')
}

// 2. choose → invoke 参数 {requestId, optionId} 原样 + resolve ok → settled
{
  const h = setup(['allow_once', 'reject_once'])
  h.receive()
  await h.controller.choose(1, 'allow_once')
  assert.deepEqual(h.invokeCalls, [{ cmd: 'approve_tool_call', args: { requestId: 1, optionId: 'allow_once' } }])
  assert.equal(h.timer.activeCount(), 0, 'answering 必须清 timer')
}

// 3. invoke 失败 → 回 pending 记 lastError，可换 option 重试
{
  const h = setup(['allow_once', 'deny'], async () => { throw new Error('protocol_error: 内部错误') })
  h.receive()
  await h.controller.choose(1, 'allow_once')
  const failAction = h.actions[h.actions.length - 1]
  assert.equal(failAction?.type, 'resolve')
  assert.equal(failAction?.ok, false)
  assert.equal(failAction?.error, 'protocol_error: 内部错误')
  assert.equal(h.timer.activeCount(), 1, '回 pending 后必须重新挂 timer')
}

// 4. invoke 失败「请求不存在」→ 直接 settled，不留 pending
{
  const h = setup(['allow_once'], async () => { throw new Error('protocol_error: 请求不存在') })
  h.receive()
  await h.controller.choose(1, 'allow_once')
  const last = h.actions[h.actions.length - 1]
  assert.equal(last?.type, 'resolve')
  assert.equal(last?.ok, true, '请求不存在必须 settled')
}

// 5. 超时 → 触发 reject_once 并 invoke
{
  const h = setup(['allow_once', 'reject_once'])
  h.receive()
  h.fire()
  assert.deepEqual(h.invokeCalls, [{ cmd: 'approve_tool_call', args: { requestId: 1, optionId: 'reject_once' } }])
}

// 6. 超时无 reject_once → 第一个 deny/reject 语义 option
{
  const h = setup(['allow_once', 'deny_always'])
  h.receive()
  h.fire()
  assert.deepEqual(h.invokeCalls, [{ cmd: 'approve_tool_call', args: { requestId: 1, optionId: 'deny_always' } }])
}

// 7. 超时无任何可拒绝项 → 本地 reject，不 invoke、不伪造 optionId
{
  const h = setup(['allow_once', 'allow_always'])
  h.receive()
  h.fire()
  assert.equal(h.invokeCalls.length, 0)
  assert.equal(h.actions.some(a => a.type === 'reject'), true)
}

// 8. dispose → listener stop + 清全部 timer；不 invoke
{
  const h = setup(['allow_once', 'reject_once'])
  h.receive()
  await h.controller.dispose()
  assert.equal(h.stopCalled, true, 'unmount 必须停止 listener')
  assert.equal(h.timer.activeCount(), 0, 'unmount 必须清全部 timer')
  assert.equal(h.invokeCalls.length, 0, 'unmount 不得向后端发送拒绝')
}

// 9. normalize：非法输入全部 null；合法输入收窄正确
assert.equal(normalizePermissionRequest(null), null)
assert.equal(normalizePermissionRequest('str'), null)
assert.equal(normalizePermissionRequest({}), null)
assert.equal(normalizePermissionRequest({ requestId: 'abc', options: [{ optionId: 'x' }] }), null)
assert.equal(normalizePermissionRequest({ requestId: 1, options: [] }), null)
assert.equal(normalizePermissionRequest({ requestId: 1, options: [{}] }), null)
assert.equal(normalizePermissionRequest({ requestId: 1, options: [{ optionId: '' }] }), null, '空 optionId 必须拒绝')
{
  // 数字 optionId 宽容强转字符串（不伪造、不拒绝）
  const r = normalizePermissionRequest({ requestId: 1, options: [{ optionId: 42 }] })
  assert.equal(r?.options[0]?.optionId, '42')
}
{
  const r = normalizePermissionRequest(wirePayload(7, ['allow_once']))
  assert.equal(r?.requestId, 7)
  assert.equal(r?.options[0]?.optionId, 'allow_once')
}

// 10. resolveTimeoutDenyOption 优先级
assert.equal(resolveTimeoutDenyOption([{ optionId: 'allow_once' }, { optionId: 'reject_once' }])?.optionId, 'reject_once')
assert.equal(resolveTimeoutDenyOption([{ optionId: 'allow_once' }, { optionId: 'deny' }])?.optionId, 'deny')
assert.equal(resolveTimeoutDenyOption([{ optionId: 'allow_once' }, { optionId: 'allow_always' }]), null)

// 11. 超时常量
assert.equal(PERMISSION_TIMEOUT_MS, 300_000)

console.log('permission controller mock 守卫通过')
