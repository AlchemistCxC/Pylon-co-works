import { describe, expect, it } from 'vitest'
import {
  createPermissionController,
  normalizePermissionRequest,
  resolveTimeoutDenyOption,
  type PermissionControllerDeps,
} from '../permissionController.ts'
import {
  permissionReducer,
  EMPTY_PERMISSION_STATE,
  type PermissionAction,
  type PermissionState,
} from '../../../domains/permission/permissionState.ts'

/**
 * ACP-01 前端聚焦测试：requestId 原值保留（wire 字符串回显，不 Number() 收窄）。
 *
 * 回归锚点：旧实现 `Number(envelope.requestId)` + `isFinite` 会把 string id
 * （"perm-1"）得 NaN → 整单丢弃。新实现保留原样——string-id agent（Hermes 等）
 * 的权限请求不再被前端静默丢弃。
 */

function eventWith(requestId: unknown): unknown {
  return {
    provider: 'peri',
    agentId: 'peri-a',
    sessionId: 's1',
    eventType: 'permission.request',
    requestId,
    clientGeneration: 3,
    payload: {
      options: [{ optionId: 'allow_once' }, { optionId: 'reject_once' }],
      title: '执行 Bash',
    },
  }
}

describe('normalizePermissionRequest（ACP-01 requestId 类型化）', () => {
  it('string id "perm-1" 原样保留（旧实现 Number→NaN 整单丢弃）', () => {
    const request = normalizePermissionRequest(eventWith('perm-1'))
    expect(request).not.toBeNull()
    expect(request?.requestId).toBe('perm-1')
  })

  it('numeric 回显 "7" 保留字符串形态（不转回 number）', () => {
    const request = normalizePermissionRequest(eventWith('7'))
    expect(request?.requestId).toBe('7')
    expect(typeof request?.requestId).toBe('string')
  })

  it('缺 requestId 仍返回 null（不可提交，不臆造 0）', () => {
    expect(normalizePermissionRequest(eventWith(undefined))).toBeNull()
    expect(normalizePermissionRequest(eventWith(null))).toBeNull()
  })

  it('timeout deny 优先 reject_once，其次 deny/reject 语义（ACP-02 kind 兼容）', () => {
    expect(
      resolveTimeoutDenyOption([{ optionId: 'allow_once' }, { optionId: 'reject_once' }])?.optionId,
    ).toBe('reject_once')
    // kind=reject_once 语义类别（Hermes：optionId=deny + kind=reject_once）
    expect(
      resolveTimeoutDenyOption([
        { optionId: 'allow_once' },
        { optionId: 'deny', kind: 'reject_once' },
      ])?.optionId,
    ).toBe('deny')
    // 无任何拒绝语义 → null（不伪造 optionId）
    expect(resolveTimeoutDenyOption([{ optionId: 'allow_once' }])).toBeNull()
  })

  it('camelCase kind/optionId（rejectOnce）与 snake_case 语义同义（ACP-04 CR-001）', () => {
    // Hermes：optionId=deny + kind=rejectOnce（camelCase）——必须优先 reject_once 语义项
    expect(
      resolveTimeoutDenyOption([
        { optionId: 'deny' },
        { optionId: 'allow_once', kind: 'rejectOnce' },
      ])?.optionId,
    ).toBe('allow_once')
    // optionId 本身为 camelCase rejectOnce
    expect(
      resolveTimeoutDenyOption([{ optionId: 'rejectOnce' }, { optionId: 'allow_once' }])?.optionId,
    ).toBe('rejectOnce')
    // 较早 deny 项存在时仍选 reject_once 语义项（与后端 pick_option 优先级一致）
    expect(
      resolveTimeoutDenyOption([
        { optionId: 'deny' },
        { optionId: 'allow_always', kind: 'rejectOnce' },
      ])?.optionId,
    ).toBe('allow_always')
  })
})

// ── 迁移自 scripts/test-permission-controller.mts（P91 A1）──
// interaction transport mock 守卫：choose/resolved/dispose 全链路（ACP-03 §5.6）

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
    listen: (event, h) => { expect(event).toBe('pylon:interaction'); handler = h as typeof handler; return Promise.resolve(() => { stopCalled = true }) },
    invoke: async (cmd, args) => {
      invokeCalls.push({ cmd, args: args as Record<string, unknown> })
      if (invokeImpl) return invokeImpl(cmd, args as Record<string, unknown>)
      return null
    },
    now: () => 1000,
  }
  const controller = createPermissionController(deps)
  const receive = (requestId = 1, opts = options) => { expect(handler).not.toBeNull(); handler!({ payload: wirePayload(requestId, opts) }) }
  const emitResolved = (requestId: string, clientGeneration?: number) => { expect(handler).not.toBeNull(); handler!({ payload: resolvedEvent(requestId, clientGeneration) }) }
  return { controller, actions, invokeCalls, get stopCalled() { return stopCalled }, state: () => state, receive, emitResolved }
}

describe('permissionController interaction transport（迁移自 scripts/test-permission-controller.mts，P91 A1）', () => {
  it('ACP-03 §5.6：receive 只入状态，不创建前端 timer', () => {
    const h = setup(['allow_once', 'reject_once'])
    h.receive()
    expect(h.actions[0]?.type).toBe('receive')
  })

  it('choose → respond_interaction invoke（identity/kind/answer 契约）', async () => {
    const h = setup(['allow_once', 'reject_once'])
    h.receive()
    await h.controller.choose('1', 'allow_once')
    expect(h.invokeCalls[0]).toEqual({
      cmd: 'respond_interaction',
      args: {
        identity: { provider: 'peri', agentId: 'peri', requestId: '1', sessionId: 's1', toolCallId: 't1', clientGeneration: 3 },
        kind: 'approval', answer: { optionId: 'allow_once' },
      },
    })
  })

  it('invoke 协议错误 → resolve ok:false（可重试）', async () => {
    const h = setup(['allow_once', 'deny'], async () => { throw new Error('protocol_error') })
    h.receive(); await h.controller.choose('1', 'allow_once')
    const lastAction = h.actions.at(-1)
    expect(lastAction?.type).toBe('resolve')
    // resolve 变体携带 ok 标志（协议错误 → ok:false 可重试）
    expect(lastAction && lastAction.type === 'resolve' ? lastAction.ok : undefined).toBe(false)
  })

  it('ACP-03 §5.6：permission.resolved 命中 active → settle，前端不得自行 invoke', () => {
    const h = setup(['allow_once', 'reject_once'])
    h.receive()
    h.emitResolved('1', 3)
    expect(h.invokeCalls.length).toBe(0) // 超时 settle 不得触发前端 invoke
    const last = h.actions.at(-1)
    expect(last?.type).toBe('resolve')
    // 超时 settle 的 resolve 变体 ok:true
    expect(last && last.type === 'resolve' ? last.ok : undefined).toBe(true)
    expect((last as { clientGeneration?: number }).clientGeneration).toBe(3)
    expect(h.state().byAgent.peri.active).toBeNull() // 超时 settle 后 active 弹出
  })

  it('ACP-03：permission.resolved 命中 queued（非 active）——只从队列移除，不动 active', () => {
    const h = setup(['allow_once', 'reject_once'])
    h.receive(1)
    h.receive(2)
    expect(h.state().byAgent.peri.queued.length).toBe(1) // 第二请求必须入队
    h.emitResolved('2', 3)
    expect(h.state().byAgent.peri.queued.length).toBe(0) // queued 超时条目必须移除
    expect(h.state().byAgent.peri.active?.request.requestId).toBe('1') // active 不受影响
  })

  it('dispose 停 listener 且不 invoke', async () => {
    const h = setup(['allow_once']); h.receive(); await h.controller.dispose()
    expect(h.stopCalled).toBe(true); expect(h.invokeCalls.length).toBe(0)
  })

  it('normalizePermissionRequest 宽容收窄 + deadlineMs 透传 + requestedAt 字符串分支', () => {
    expect(normalizePermissionRequest(null)).toBeNull()
    expect(normalizePermissionRequest({ requestId: 1, options: [{ optionId: 'x' }] })).toBeNull()
    expect(normalizePermissionRequest(wirePayload(7, ['allow_once']))?.requestId).toBe('7')
    // ACP-03：deadlineMs 透传（后端单一来源，前端只读展示）。
    expect(normalizePermissionRequest(wirePayload(9, ['allow_once']))?.deadlineMs).toBe(123 + 300_000)
    // WI-04 CR-001 吸收：requestedAt 字符串分支（Rust Timestamp 字符串 wire）
    const strAt = normalizePermissionRequest({
      ...wirePayload(8, ['allow_once']),
      payload: { ...wirePayload(8, ['allow_once']).payload, requestedAt: '2026-08-13T00:00:00Z' },
    })
    expect(strAt?.requestedAt).toBe('2026-08-13T00:00:00Z')
    expect(resolveTimeoutDenyOption([{ optionId: 'allow_once' }, { optionId: 'reject_once' }])?.optionId).toBe('reject_once')
  })
})
