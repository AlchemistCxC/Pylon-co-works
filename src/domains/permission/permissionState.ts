/**
 * permissionState — 权限请求纯状态机（P0-01，P1-1 按 agent 隔离）。
 *
 * R2-WI05（Phase E）：不再使用全局单 active 槽——状态按 `request.agentId` 分片
 * （byAgent），同 provider 多 agentId / 同 agent 多 session 的请求互不串槽；
 * 后台 agent 的请求停放在其切片内，切回该 agent 继续展示。每个 agent 切片内部
 * 保持既有语义：单 active + FIFO queue、每个 request 只应答一次、迟到 resolve
 * 无操作、options 保持 wire 顺序。
 *
 * 核心不变量：**每个 request 只应答一次**——同 requestId 第二次 choose 无操作；
 * 迟到 resolve（请求已 timeout/settled 被弹出）无操作；settled 的请求即被丢弃。
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

/** 单个 agent 的权限切片（单 active + FIFO queue，语义与旧全局状态一致）。 */
export interface PermissionAgentSlice {
  active: PermissionRequestState | null
  queued: PermissionRequestState[]
}

/** 按 agentId 分片的权限状态——同 provider 多 agentId / 多 session 不串槽。 */
export interface PermissionState {
  byAgent: Record<string, PermissionAgentSlice>
}

export const EMPTY_PERMISSION_STATE: PermissionState = { byAgent: {} }

export function emptyAgentSlice(): PermissionAgentSlice {
  return { active: null, queued: [] }
}

/** 当前 agent 的 active 请求（无则 null）。 */
export function activeForAgent(state: PermissionState, agentId: string): PermissionRequestState | null {
  return state.byAgent[agentId]?.active ?? null
}

/** 当前 agent 的完整切片（无则空切片，不产生新引用写入）。 */
export function sliceForAgent(state: PermissionState, agentId: string): PermissionAgentSlice {
  return state.byAgent[agentId] ?? emptyAgentSlice()
}

export type PermissionAction =
  | { type: 'receive'; request: PermissionRequest; now?: number }
  | { type: 'choose'; agentId: string; requestId: string; optionId: string }
  | { type: 'resolve'; agentId: string; requestId: string; ok: boolean; error?: string; clientGeneration?: number }
  /** 本地 settle（无 deny 项时 controller 用，不 invoke） */
  | { type: 'reject'; agentId: string; requestId: string }
  | { type: 'timeout'; agentId: string; requestId: string }
  /** 清理指定 agent 的全部权限状态（重连/切换场景用） */
  | { type: 'clear-agent'; agentId: string }
  | { type: 'clear' }

export function permissionReducer(state: PermissionState, action: PermissionAction): PermissionState {
  switch (action.type) {
    case 'receive': {
      const agentId = action.request.agentId
      // 无 agentId 的请求不进状态（旧 wire/无法归属——防未知请求占槽）
      if (!agentId) return state
      const slice = state.byAgent[agentId] ?? emptyAgentSlice()
      // 防双答去重必须是 (requestId, clientGeneration) 双键：重连后新客户端从低 id
      // 重新编号，会与停放的同 agent 旧代请求 requestId 撞车——只按 requestId 去重
      // 会把新客户端的真实请求误当重复丢弃（WI-06 玉衡发现的边界）。
      const isSameRequest = (entry: PermissionRequestState) =>
        entry.request.requestId === action.request.requestId
        && entry.request.clientGeneration === action.request.clientGeneration
      if (slice.active && isSameRequest(slice.active)) return state
      if (slice.queued.some(isSameRequest)) return state
      // P1-1 stale generation 失效（Phase E #4，WI-05 CR-201 吸收）：
      // 客户端替换（generation 前进）后旧代请求失效——更高代到达时清掉旧代切片
      // 条目；更低代（迟到旧客户端）请求丢弃，不让 stale 覆盖/排队在新鲜代之后。
      const newGen = action.request.clientGeneration
      if (slice.active && slice.active.request.clientGeneration > newGen) return state
      if (slice.queued.some(entry => entry.request.clientGeneration > newGen)) return state
      const entry: PermissionRequestState = {
        request: action.request,
        status: 'pending',
        receivedAt: action.now ?? Date.now(),
      }
      const keptActive = slice.active && slice.active.request.clientGeneration < newGen ? null : slice.active
      const keptQueued = slice.queued.filter(entry => entry.request.clientGeneration >= newGen)
      const nextSlice = !keptActive
        ? { active: entry, queued: keptQueued }
        : { active: keptActive, queued: [...keptQueued, entry] }
      return { ...state, byAgent: { ...state.byAgent, [agentId]: nextSlice } }
    }
    case 'choose':
    case 'resolve':
    case 'reject':
    case 'timeout':
      return mapAgentSlice(state, action.agentId, slice => reduceSliceAction(slice, action))
    case 'clear-agent': {
      if (!state.byAgent[action.agentId]) return state
      const { [action.agentId]: _removed, ...rest } = state.byAgent
      return { byAgent: rest }
    }
    case 'clear':
      return EMPTY_PERMISSION_STATE
  }
}

function mapAgentSlice(
  state: PermissionState,
  agentId: string,
  fn: (slice: PermissionAgentSlice) => PermissionAgentSlice,
): PermissionState {
  if (!state.byAgent[agentId]) return state
  return { ...state, byAgent: { ...state.byAgent, [agentId]: fn(state.byAgent[agentId]) } }
}

/** 切片内 active 级操作（防双答 / 超时 / 回退 / settle 语义与旧全局状态一致）。 */
function reduceSliceAction(
  slice: PermissionAgentSlice,
  action: Extract<PermissionAction, { type: 'choose' | 'resolve' | 'reject' | 'timeout' }>,
): PermissionAgentSlice {
  const { active } = slice
  // ACP-03：后端 permission.resolved（超时/cancel/stale）可能命中 queued（非 active）
  // 请求——从队列移除该条目，不动 active（active 命中走下方 settleAndPop；invoke 路径
  // 恒指 active，不进本分支）。
  if (action.type === 'resolve' && action.ok && (!active || active.request.requestId !== action.requestId)) {
    const queuedIndex = slice.queued.findIndex(
      entry =>
        entry.request.requestId === action.requestId &&
        (action.clientGeneration === undefined ||
          entry.request.clientGeneration === action.clientGeneration),
    )
    if (queuedIndex >= 0) {
      return { ...slice, queued: slice.queued.filter((_, i) => i !== queuedIndex) }
    }
  }
  if (!active || active.request.requestId !== action.requestId) return slice
  switch (action.type) {
    case 'choose': {
      if (active.status !== 'pending') return slice
      if (!active.request.options.some(option => option.optionId === action.optionId)) return slice
      return { ...slice, active: { ...active, status: 'answering', chosenOptionId: action.optionId } }
    }
    case 'resolve': {
      if (action.ok) return settleAndPopSlice(slice)
      // invoke 失败：回 pending 记录 lastError、清旧选择，允许用户换 option 重试
      if (active.status === 'answering' || active.status === 'pending') {
        return { ...slice, active: { ...active, status: 'pending', chosenOptionId: undefined, lastError: action.error } }
      }
      return slice
    }
    case 'reject': {
      if (active.status === 'settled' || active.status === 'timed-out') return slice
      return settleAndPopSlice(slice)
    }
    case 'timeout': {
      // answering 期间 timer 已被清；防御性只 settle pending
      if (active.status !== 'pending') return slice
      return settleAndPopSlice(slice)
    }
  }
}

function settleAndPopSlice(slice: PermissionAgentSlice): PermissionAgentSlice {
  // settled 请求即被丢弃（不留在状态里），弹出队首成为下一 active
  const [next, ...rest] = slice.queued
  return { active: next ?? null, queued: rest }
}
