/**
 * B1：Agent 草稿 → 验证 → 保存 的显式状态机。
 *
 * 设置页编辑现有 Agent 的生命周期以前散落在 verifiedDrafts/testingId/savingId
 * 三个互不约束的 state 里；本模块把它收拢为一个 reducer，使不变量可被测试
 * 锁定而不是靠组件自觉：
 *
 * - 状态固定为 empty → editing → testing → verified/failed → saving/saved；
 * - 保存 fail-closed：只有 verified 且 verifiedFingerprint 与草稿当前指纹
 *   相等才允许进入 saving；
 * - 草稿任一字段变更或切换 agent 立即丢弃旧验证；
 * - 验证结果携带请求序号，取消/过期结果不落地。
 */

export type AgentDraftPhase = 'empty' | 'editing' | 'testing' | 'verified' | 'failed' | 'saving' | 'saved'

export interface AgentDraftState {
  phase: AgentDraftPhase
  /** 正在编辑的 agent；null = 没有打开编辑器。 */
  agentId: string | null
  /** 草稿当前指纹（name/provider/exe/args 的稳定投影）。 */
  fingerprint: string | null
  /** 一次成功验证所验证过的指纹；保存门槛 = 与当前指纹相等。 */
  verifiedFingerprint: string | null
  /** 单调递增的验证请求序号：旧序号的结果一律丢弃。 */
  testRequestId: number
  /** 最近一次已落地的验证结果文案（成功或失败）。 */
  testMessage: string | null
}

export type AgentDraftAction =
  | { type: 'select'; agentId: string | null }
  | { type: 'edit'; fingerprint: string }
  | { type: 'testBegin' }
  | { type: 'testEnd'; requestId: number; ok: boolean; testedFingerprint: string; message: string }
  | { type: 'testCancel' }
  | { type: 'saveBegin' }
  | { type: 'saveEnd'; ok: boolean }

/** 草稿指纹：与后端可见字段一一对应（name/provider/exe/args），键序固定。 */
export function agentDraftFingerprint(input: {
  name: string
  provider: string
  exe: string
  args: readonly string[]
}): string {
  return JSON.stringify({
    name: input.name.trim(),
    provider: input.provider.trim(),
    exe: input.exe.trim(),
    args: input.args,
  })
}

export function initialAgentDraftState(): AgentDraftState {
  return {
    phase: 'empty',
    agentId: null,
    fingerprint: null,
    verifiedFingerprint: null,
    testRequestId: 0,
    testMessage: null,
  }
}

/** 保存门槛：verified 且验证过的指纹与草稿当前指纹相等（fail-closed）。 */
export function canSaveAgentDraft(state: AgentDraftState): boolean {
  return (
    state.phase === 'verified'
    && state.verifiedFingerprint !== null
    && state.verifiedFingerprint === state.fingerprint
  )
}

export function agentDraftReducer(state: AgentDraftState, action: AgentDraftAction): AgentDraftState {
  switch (action.type) {
    case 'select': {
      // 切换 agent（含关闭编辑器）：一切旧验证立即失效。
      if (action.agentId === null) return initialAgentDraftState()
      return {
        ...initialAgentDraftState(),
        phase: 'editing',
        agentId: action.agentId,
      }
    }
    case 'edit': {
      // saving 期间编辑被 UI 禁用；reducer 防御性拒绝，防止半保存状态被改写。
      if (state.phase === 'saving' || state.phase === 'saved') return state
      if (state.phase === 'empty') return state
      // 草稿变更 → 回到 editing 并丢弃旧验证。fingerprint 相等时同样回到
      // editing：一次无操作的 setDraft 不应伪造成「已验证」。
      return {
        ...state,
        phase: 'editing',
        fingerprint: action.fingerprint,
        verifiedFingerprint: null,
      }
    }
    case 'testBegin': {
      // 只能从 editing/verified/failed 发起；testing 中禁用重复测试，saving 中
      // 禁用一切（按钮 disabled + reducer 双保险）。
      if (state.phase !== 'editing' && state.phase !== 'verified' && state.phase !== 'failed') return state
      return {
        ...state,
        phase: 'testing',
        testRequestId: state.testRequestId + 1,
        testMessage: null,
      }
    }
    case 'testEnd': {
      // 旧请求的结果（取消/被新验证取代后到达）不落地。
      if (state.phase !== 'testing' || action.requestId !== state.testRequestId) return state
      if (action.ok) {
        // 记录「验证过的指纹」——若用户在验证期间改了草稿，当前指纹会与它
        // 不等，保存门槛（canSave）自然挡住，直到重新验证。
        return {
          ...state,
          phase: 'verified',
          verifiedFingerprint: action.testedFingerprint,
          testMessage: action.message,
        }
      }
      return {
        ...state,
        phase: 'failed',
        verifiedFingerprint: null,
        testMessage: action.message,
      }
    }
    case 'testCancel': {
      if (state.phase !== 'testing') return state
      // 递增请求序号使在途结果作废；回到 editing 允许再次编辑/重测。
      return {
        ...state,
        phase: 'editing',
        testRequestId: state.testRequestId + 1,
        testMessage: null,
      }
    }
    case 'saveBegin': {
      // fail-closed：reducer 层再校验一次保存门槛。
      if (!canSaveAgentDraft(state)) return state
      return { ...state, phase: 'saving' }
    }
    case 'saveEnd': {
      if (state.phase !== 'saving') return state
      if (action.ok) {
        return { ...state, phase: 'saved', testMessage: null }
      }
      // 保存失败（含 CAS 冲突）：回到 verified，草稿与验证都保留，可重试保存。
      return { ...state, phase: 'verified' }
    }
  }
}
