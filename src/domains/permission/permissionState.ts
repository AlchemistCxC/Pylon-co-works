/**
 * permissionState — 权限请求纯状态机（P0-01）。
 *
 * 单 active + FIFO queue（细化路线 §2 方案 A）：弹窗只展示 active，收到请求时
 * active 空则置 active，否则入队；settled 后弹出队首成为下一 active。
 *
 * 核心不变量：**每个 request 只应答一次**——同 requestId 第二次 choose 无操作；
 * 迟到 resolve（请求已 timeout/settled 被弹出）无操作；settled 的请求即被丢弃
 * （历史在事件里，不在状态里）。options 保持 wire 顺序与 optionId 原值。
 * 超时/拒绝选项选择等 wire 语义由 controller（P0-02）翻译后 dispatch，本域不解释 wire。
 */

import type { PermissionRequest } from './permissionTypes.ts'

export type PermissionStatus = 'pending' | 'answering' | 'settled' | 'timed-out'

export interface PermissionRequestState {
  request: PermissionRequest
  status: PermissionStatus
  receivedAt: number
  chosenOptionId?: string
  lastError?: string
}

export interface PermissionState {
  active: PermissionRequestState | null
  queued: PermissionRequestState[]
}

export const EMPTY_PERMISSION_STATE: PermissionState = { active: null, queued: [] }

export type PermissionAction =
  | { type: 'receive'; request: PermissionRequest; now?: number }
  | { type: 'choose'; requestId: number; optionId: string }
  | { type: 'resolve'; requestId: number; ok: boolean; error?: string }
  /** 本地 settle（无 deny 项时 controller 用，不 invoke） */
  | { type: 'reject'; requestId: number }
  | { type: 'timeout'; requestId: number }
  | { type: 'clear' }

export function permissionReducer(state: PermissionState, action: PermissionAction): PermissionState {
  switch (action.type) {
    case 'receive': {
      if (state.active && state.active.request.requestId === action.request.requestId) return state
      if (state.queued.some(entry => entry.request.requestId === action.request.requestId)) return state
      const entry: PermissionRequestState = {
        request: action.request,
        status: 'pending',
        receivedAt: action.now ?? Date.now(),
      }
      if (!state.active) return { active: entry, queued: state.queued }
      return { active: state.active, queued: [...state.queued, entry] }
    }
    case 'choose': {
      const { active } = state
      if (!active || active.request.requestId !== action.requestId) return state
      if (active.status !== 'pending') return state
      if (!active.request.options.some(option => option.optionId === action.optionId)) return state
      return { ...state, active: { ...active, status: 'answering', chosenOptionId: action.optionId } }
    }
    case 'resolve': {
      const { active } = state
      if (!active || active.request.requestId !== action.requestId) return state
      if (action.ok) return settleAndPop(state)
      // invoke 失败：回 pending 记录 lastError、清旧选择，允许用户换 option 重试（细化路线 §2 步骤 4）
      if (active.status === 'answering' || active.status === 'pending') {
        return { ...state, active: { ...active, status: 'pending', chosenOptionId: undefined, lastError: action.error } }
      }
      return state
    }
    case 'reject': {
      const { active } = state
      if (!active || active.request.requestId !== action.requestId) return state
      if (active.status === 'settled' || active.status === 'timed-out') return state
      return settleAndPop(state)
    }
    case 'timeout': {
      const { active } = state
      if (!active || active.request.requestId !== action.requestId) return state
      // answering 期间 timer 已被清；防御性只 settle pending
      if (active.status !== 'pending') return state
      return settleAndPop(state)
    }
    case 'clear':
      return EMPTY_PERMISSION_STATE
  }
}

function settleAndPop(state: PermissionState): PermissionState {
  // settled 请求即被丢弃（不留在状态里），弹出队首成为下一 active
  const [next, ...rest] = state.queued
  return { active: next ?? null, queued: rest }
}
