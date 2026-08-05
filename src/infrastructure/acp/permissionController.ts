/**
 * permissionController — 权限请求接线层（P0-02）。
 *
 * infrastructure 收边界：负责 Tauri `pylon:permission-request` listen 与
 * `approve_tool_call` invoke，以及 300s 超时处理；状态归 domains/permission 纯 reducer，
 * 本层只做 normalize → dispatch → invoke → dispatch。store 读写经注入（dispatch/getState），
 * 不直接 import runtimeStore——测试可注入 mock 全链路断言，不依赖 Tauri runtime。
 *
 * 超时策略（细化路线 §2）：触发 reject_once 仅当 wire options 含该 optionId；否则选第一个
 * deny/reject 语义 option；没有可拒绝项则本地 settle 并报错，不伪造 optionId。
 */

import { reportRuntimeError } from '../../runtimeError.ts'
import type { PermissionAction, PermissionState } from '../../domains/permission/permissionState.ts'
import type { PermissionOption, PermissionRequest } from '../../domains/permission/permissionTypes.ts'

export const PERMISSION_TIMEOUT_MS = 300_000

export interface PermissionControllerDeps {
  /** store 写入口：dispatch 纯 reducer action */
  dispatch: (action: PermissionAction) => void
  /** store 读入口：当前权限状态（syncTimer/handleTimeout 用） */
  getState: () => PermissionState
  /** Tauri listen：返回 stop 函数 */
  listen: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>
  /** Tauri invoke（approve_tool_call） */
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
  now?: () => number
}

export interface PermissionController {
  /** 用户/超时选择 option：choose → invoke → resolve；失败回 pending 可重试 */
  choose: (requestId: number, optionId: string) => Promise<void>
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

/** wire payload 最小 normalize：requestId 可安全转 number、options 非空且每项含 optionId；否则 null */
export function normalizePermissionRequest(payload: unknown): PermissionRequest | null {
  if (!isPlainObject(payload)) return null
  const requestId = Number(payload.requestId)
  if (!Number.isFinite(requestId)) return null
  const options = Array.isArray(payload.options)
    ? payload.options
        .filter(isPlainObject)
        // 先筛 optionId 存在（缺失经 String 会变成 'undefined' 字符串而漏过），再宽容强转
        .filter(option => option.optionId != null && String(option.optionId).length > 0)
        .map(option => ({ ...option, optionId: String(option.optionId) }))
    : []
  if (options.length === 0) return null
  return {
    requestId,
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
    toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined,
    title: typeof payload.title === 'string' ? payload.title : undefined,
    prompt: typeof payload.prompt === 'string' ? payload.prompt : undefined,
    requestedAt: typeof payload.requestedAt === 'number' ? payload.requestedAt : undefined,
    options,
  }
}

/** 超时拒绝项选择：优先 reject_once，其次第一个 deny/reject 语义 option，无则 null */
export function resolveTimeoutDenyOption(options: PermissionOption[]): PermissionOption | null {
  const rejectOnce = options.find(option => option.optionId === 'reject_once')
  if (rejectOnce) return rejectOnce
  return options.find(option => /deny|reject/i.test(option.optionId)) ?? null
}

export function createPermissionController(deps: PermissionControllerDeps): PermissionController {
  let disposed = false
  let unlistenFn: (() => void) | null = null
  let timerHandle: unknown = null
  let timerRequestId: number | null = null

  const setTimer = (fn: () => void, ms: number): unknown =>
    deps.setTimeoutFn ? deps.setTimeoutFn(fn, ms) : setTimeout(fn, ms)

  const clearTimerHandle = (handle: unknown): void => {
    if (deps.clearTimeoutFn) deps.clearTimeoutFn(handle)
    else if (typeof handle === 'number') clearTimeout(handle)
  }

  const clearTimer = () => {
    if (timerHandle !== null) clearTimerHandle(timerHandle)
    timerHandle = null
    timerRequestId = null
  }

  /** 每次 dispatch 后校准 timer：只对 active pending 请求挂 300s 超时；answering/无 active 即清 */
  const syncTimer = () => {
    const active = deps.getState().active
    if (!active || active.status !== 'pending') {
      clearTimer()
      return
    }
    if (active.request.requestId === timerRequestId) return
    clearTimer()
    timerRequestId = active.request.requestId
    const requestId = active.request.requestId
    timerHandle = setTimer(() => handleTimeout(requestId), PERMISSION_TIMEOUT_MS)
  }

  const dispatch = (action: PermissionAction) => {
    if (disposed) return
    deps.dispatch(action)
    syncTimer()
  }

  const approve = async (requestId: number, optionId: string) => {
    try {
      await deps.invoke('approve_tool_call', { requestId, optionId })
      dispatch({ type: 'resolve', requestId, ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 请求不存在（已应答/超时/已清）→ 直接 settled；其余回 pending 允许换 option 重试
      if (/不存在|not ?found|stale/i.test(message)) {
        dispatch({ type: 'resolve', requestId, ok: true })
      } else {
        dispatch({ type: 'resolve', requestId, ok: false, error: message })
      }
    }
  }

  const handleTimeout = (requestId: number) => {
    timerHandle = null
    timerRequestId = null
    if (disposed) return
    const active = deps.getState().active
    if (!active || active.request.requestId !== requestId || active.status !== 'pending') return
    const denyOption = resolveTimeoutDenyOption(active.request.options)
    if (denyOption) {
      dispatch({ type: 'choose', requestId, optionId: denyOption.optionId })
      void approve(requestId, denyOption.optionId)
    } else {
      dispatch({ type: 'reject', requestId })
      reportRuntimeError('权限请求超时', '没有可用的拒绝选项，已本地关闭请求')
    }
  }

  const onRequest = (event: { payload: unknown }) => {
    if (disposed) return
    const request = normalizePermissionRequest(event.payload)
    if (!request) return
    dispatch({ type: 'receive', request, now: deps.now ? deps.now() : Date.now() })
  }

  deps.listen<unknown>('pylon:permission-request', onRequest).then(stop => {
    if (disposed) {
      stop()
      return
    }
    unlistenFn = stop
  }).catch(error => reportRuntimeError('监听权限请求', error))

  const choose = async (requestId: number, optionId: string) => {
    dispatch({ type: 'choose', requestId, optionId })
    await approve(requestId, optionId)
  }

  const dispose = async () => {
    if (disposed) return
    disposed = true
    // 先停止 listener，再清全部 timer；不向后端发送拒绝（防热重载误拒工具）
    if (unlistenFn) {
      const stop = unlistenFn
      unlistenFn = null
      await stop()
    }
    clearTimer()
  }

  return { choose, dispose }
}
