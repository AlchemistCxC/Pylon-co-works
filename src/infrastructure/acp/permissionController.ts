/**
 * permissionController — 权限请求接线层（P0-02）。
 *
 * infrastructure 收边界：负责 Tauri `pylon:permission-request` listen 与
 * `approve_tool_call` invoke，以及 300s 超时处理；状态归 domains/permission 纯 reducer，
 * 本层只做 normalize → dispatch → invoke → dispatch。store 读写经注入（dispatch/getState），
 * 不直接 import runtimeStore——测试可注入 mock 全链路断言，不依赖 Tauri runtime。
 *
 * 超时策略（ACP-03 §5.6）：超时判定与应答由后端唯一所有——后端 watcher 超时后发出
 * permission.resolved（timed_out）terminal 事件；前端只展示倒计时（deadlineMs 来自后端
 * payload，不硬编码常量）并提交用户选择，**不自行触发超时应答**（invariant 5：不得自行
 * 宣称 agent 已收到 response）。
 */

import { reportRuntimeError, resolveRuntimeErrors } from '../../runtimeError.ts'
import { activeForAgent, type PermissionAction, type PermissionState } from '../../domains/permission/permissionState.ts'
import type { PermissionOption, PermissionRequest } from '../../domains/permission/permissionTypes.ts'
import { normalizeInteractionEnvelope } from '../../domains/activity/interaction.ts'
import { createInteractionResponseTransport } from './interactionTransport.ts'

export interface PermissionControllerDeps {
  /** store 写入口：dispatch 纯 reducer action */
  dispatch: (action: PermissionAction) => void
  /** store 读入口：当前权限状态（approve 定位 active 请求用） */
  getState: () => PermissionState
  /** 当前 agentId（P1-1：状态按 agent 切片隔离，controller 只作用在当前 agent 切片） */
  getCurrentAgentId: () => string
  /** Tauri listen：返回 stop 函数 */
  listen: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>
  /** Tauri invoke（统一 interaction response transport） */
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  /** ACP-03：前端不再持有超时 timer——setTimeoutFn/clearTimeoutFn 依赖移除 */
  now?: () => number
}

export interface PermissionController {
  /** 用户/超时选择 option：choose → invoke → resolve；失败回 pending 可重试 */
  choose: (requestId: string, optionId: string) => Promise<void>
  /** 停止 listener 并清全部 timer；不向后端发送任何拒绝（防热重载误拒工具） */
  dispose: () => Promise<void>
}

// 模块级单例：P0-03 弹窗经此访问统一应答入口（同 chatEventController 的 getChatController 惯例）
let activePermissionController: PermissionController | null = null

export function registerPermissionController(controller: PermissionController | null): void {
  activePermissionController = controller
}

export function getPermissionController(): PermissionController | null {
  return activePermissionController
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** wire payload 最小 normalize：requestId 原样保留（string/number 统一字符串，不转数）、
 * options 非空且每项含 optionId；否则 null */
export function normalizePermissionRequest(payload: unknown): PermissionRequest | null {
  const envelope = normalizeInteractionEnvelope(payload)
  if (!envelope || envelope.eventType !== 'permission.request' || !isPlainObject(envelope.payload)) return null
  if (!envelope.agentId || !envelope.sessionId || !envelope.requestId || envelope.clientGeneration === undefined) return null
  const body = envelope.payload
  // ACP-01：requestId 是 wire 原值字符串回显（数字 id 也以 "7" 传输）——保留原样，
  // 不再 Number() 收窄（string id "perm-1" 曾因 isFinite(NaN) 被整单丢弃）。
  const requestId = envelope.requestId
  const options = Array.isArray(body.options)
    ? body.options
        .filter(isPlainObject)
        // 先筛 optionId 存在（缺失经 String 会变成 'undefined' 字符串而漏过），再宽容强转
        .filter(option => option.optionId != null && String(option.optionId).length > 0)
        .map(option => ({ ...option, optionId: String(option.optionId) }))
    : []
  if (options.length === 0) return null
  return {
    requestId,
    provider: envelope.provider,
    agentId: envelope.agentId,
    sessionId: envelope.sessionId,
    toolCallId: envelope.toolCallId,
    clientGeneration: envelope.clientGeneration,
    title: typeof body.title === 'string' ? body.title : undefined,
    prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
    // P1-2：Rust Timestamp 序列化为字符串、Date.now() 为 number——两类都保留。
    requestedAt: typeof body.requestedAt === 'number' || typeof body.requestedAt === 'string'
      ? body.requestedAt
      : undefined,
    // ACP-03：超时 deadline 由后端单一来源（PERMISSION_REQUEST_TIMEOUT_SECS）给出，
    // 前端只用于倒计时展示，不再自行持有 300s 常量。
    deadlineMs: typeof body.deadlineMs === 'number' ? body.deadlineMs : undefined,
    options,
  }
}

/** ACP-04（折入 ACP-02 CR-001）：镜像后端 pick_option 的归一——lowercase + 去下划线，
 * 使 camelCase kind/optionId（rejectOnce）与 snake_case（reject_once）语义同义。
 * 与 Rust `semantic` 闭包（to_ascii_lowercase + replace('_', "")）逐字对齐。 */
const normalizedKey = (value: string) => value.toLowerCase().replace(/_/g, '')

/** 超时拒绝项选择语义（ACP-02 Hermes 兼容）：优先 reject_once（optionId 或 kind，
 * 归一比较），其次第一个 deny/reject 语义 option，无则 null——**不伪造 optionId**。
 * ACP-03 后前端不再自动应答（后端唯一计时），此函数保留为 ACP-04 语义参考与单测锚点，
 * 不被 controller 调用。 */
export function resolveTimeoutDenyOption(options: PermissionOption[]): PermissionOption | null {
  const kindOf = (option: PermissionOption) => (typeof option.kind === 'string' ? option.kind : '')
  const rejectOnce =
    options.find(option => normalizedKey(option.optionId) === 'rejectonce') ??
    options.find(option => normalizedKey(kindOf(option)) === 'rejectonce')
  if (rejectOnce) return rejectOnce
  return (
    options.find(
      option => /deny|reject/i.test(option.optionId) || /deny|reject/i.test(kindOf(option)),
    ) ?? null
  )
}

export function createPermissionController(deps: PermissionControllerDeps): PermissionController {
  let disposed = false
  let unlistenFn: (() => void) | null = null
  // P1-5（R2-WI04）：统一 response transport——单一 respond_interaction payload 构造点。
  const transport = createInteractionResponseTransport({ invoke: deps.invoke })

  const currentAgentId = () => deps.getCurrentAgentId()

  // ACP-03（§5.6）：后端唯一计时——前端不再持有超时 timer，只转发 action（纯展示层）。
  const dispatch = (action: PermissionAction) => {
    if (disposed) return
    deps.dispatch(action)
  }

  const approve = async (requestId: string, optionId: string) => {
    try {
      const agentId = currentAgentId()
      const active = activeForAgent(deps.getState(), agentId)
      if (!active || active.request.requestId !== requestId) throw new Error('Interaction request 不存在或已切换')
      const request = active.request
      await transport.respond({
        identity: {
          provider: request.provider,
          agentId: request.agentId,
          requestId: String(request.requestId),
          sessionId: request.sessionId,
          toolCallId: request.toolCallId,
          clientGeneration: request.clientGeneration,
        },
        kind: 'approval',
      }, { optionId })
      dispatch({ type: 'resolve', agentId, requestId, ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const agentId = currentAgentId()
      // 请求不存在（已应答/超时/已清）→ 直接 settled；其余回 pending 允许换 option 重试
      if (/不存在|not ?found|stale/i.test(message)) {
        dispatch({ type: 'resolve', agentId, requestId, ok: true })
      } else {
        dispatch({ type: 'resolve', agentId, requestId, ok: false, error: message })
      }
    }
  }

  // ACP-03（§5.6）：后端唯一计时——前端超时不自行应答/宣称；等待后端
  // permission.resolved（timed_out）事件 settle。handleTimeout 已移除。

  /** 后端 terminal 事件：超时/cancel/stale 由后端唯一判定后发出，前端据此 settle。
   * 命中 active → resolve(ok:true) settle 弹出队首；命中 queued → 从队列移除。 */
  const handleResolved = (payload: unknown) => {
    if (disposed) return
    const envelope = isPlainObject(payload) ? payload : {}
    if (envelope.eventType !== 'permission.resolved') return
    const agentId = typeof envelope.agentId === 'string' ? envelope.agentId : ''
    const requestId = typeof envelope.requestId === 'string' ? envelope.requestId : ''
    const clientGeneration = typeof envelope.clientGeneration === 'number' ? envelope.clientGeneration : undefined
    if (!agentId || !requestId) return
    dispatch({ type: 'resolve', agentId, requestId, ok: true, clientGeneration })
  }

  const onRequest = (event: { payload: unknown }) => {
    if (disposed) return
    handleResolved(event.payload)
    const request = normalizePermissionRequest(event.payload)
    if (!request) return
    dispatch({ type: 'receive', request, now: deps.now ? deps.now() : Date.now() })
  }

  deps.listen<unknown>('pylon:interaction', onRequest).then(stop => {
    if (disposed) {
      stop()
      return
    }
    unlistenFn = stop
    resolveRuntimeErrors({ key: 'acp:permission-listener' })
  }).catch(error => {
    if (!disposed) reportRuntimeError('监听权限请求', error, undefined, {
      key: 'acp:permission-listener',
      scope: { kind: 'app', id: 'permission' },
      source: 'acp.permission',
      recovery: { kind: 'open-runtime-log' },
    })
  })

  const choose = async (requestId: string, optionId: string) => {
    dispatch({ type: 'choose', agentId: currentAgentId(), requestId, optionId })
    await approve(requestId, optionId)
  }

  const dispose = async () => {
    if (disposed) return
    disposed = true
    // 只停 listener；ACP-03 无前端 timer。不向后端发送任何拒绝（防热重载误拒工具）
    if (unlistenFn) {
      const stop = unlistenFn
      unlistenFn = null
      await stop()
    }
  }

  return { choose, dispose }
}
