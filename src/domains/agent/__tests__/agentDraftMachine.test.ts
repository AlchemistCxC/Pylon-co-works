import { describe, expect, it } from 'vitest'
import {
  agentDraftFingerprint,
  agentDraftReducer,
  canSaveAgentDraft,
  initialAgentDraftState,
  type AgentDraftAction,
  type AgentDraftState,
} from '../agentDraftMachine.ts'

function edit(fingerprint: string): AgentDraftAction {
  return { type: 'edit', fingerprint }
}

function state(overrides: Partial<AgentDraftState> = {}): AgentDraftState {
  return { ...initialAgentDraftState(), ...overrides }
}

describe('agentDraftMachine', () => {
  it('打开与切换 agent 时一切旧验证立即失效', () => {
    let current = agentDraftReducer(state(), { type: 'select', agentId: 'peri' })
    current = agentDraftReducer(current, edit('fp-1'))
    current = agentDraftReducer(current, { type: 'testBegin' })
    current = agentDraftReducer(current, {
      type: 'testEnd', requestId: 1, ok: true, testedFingerprint: 'fp-1', message: 'ok',
    })
    expect(current.phase).toBe('verified')
    expect(canSaveAgentDraft(current)).toBe(true)

    // 切到另一个 agent：验证不跟随。
    const switched = agentDraftReducer(current, { type: 'select', agentId: 'hermes' })
    expect(switched.phase).toBe('editing')
    expect(switched.agentId).toBe('hermes')
    expect(switched.verifiedFingerprint).toBeNull()
    expect(canSaveAgentDraft(switched)).toBe(false)
  })

  it('验证成功后改任一字段（指纹变化）必须重新验证才能保存', () => {
    let current = state({ phase: 'editing', agentId: 'peri', fingerprint: 'fp-1' })
    current = agentDraftReducer(current, { type: 'testBegin' })
    current = agentDraftReducer(current, {
      type: 'testEnd', requestId: 1, ok: true, testedFingerprint: 'fp-1', message: 'ok',
    })
    expect(canSaveAgentDraft(current)).toBe(true)

    current = agentDraftReducer(current, edit('fp-2'))
    expect(current.phase).toBe('editing')
    expect(current.verifiedFingerprint).toBeNull()
    expect(canSaveAgentDraft(current)).toBe(false)
  })

  it('未验证（editing/failed/testing/saving）一律不可进入保存', () => {
    const editing = state({ phase: 'editing', agentId: 'a', fingerprint: 'fp' })
    for (const phase of ['editing', 'failed', 'testing', 'saving', 'empty', 'saved'] as const) {
      const candidate = state({ phase, agentId: 'a', fingerprint: 'fp', verifiedFingerprint: 'other' })
      expect(canSaveAgentDraft(candidate)).toBe(false)
      // reducer 层同样 fail-closed：saveBegin 在门槛外是 no-op。
      const next = agentDraftReducer(candidate, { type: 'saveBegin' })
      expect(next.phase).toBe(phase)
    }
    expect(agentDraftReducer(editing, { type: 'saveBegin' }).phase).toBe('editing')
  })

  it('验证期间修改草稿：验证立即作废，在途结果不落地', () => {
    let current = state({ phase: 'editing', agentId: 'a', fingerprint: 'fp-before' })
    current = agentDraftReducer(current, { type: 'testBegin' })
    // 用户在验证 await 期间改了草稿：验证立即作废（哪怕测试本身会成功——
    // 它验证的是旧值）。
    current = agentDraftReducer(current, edit('fp-after'))
    expect(current.phase).toBe('editing')
    expect(current.verifiedFingerprint).toBeNull()

    // 旧请求结果到达时已不在 testing：整体丢弃。
    const lateResult = agentDraftReducer(current, {
      type: 'testEnd', requestId: 1, ok: true, testedFingerprint: 'fp-before', message: '连接成功',
    })
    expect(lateResult).toBe(current)
    expect(canSaveAgentDraft(lateResult)).toBe(false)

    // 重新验证当前值后才能保存。
    let retested = agentDraftReducer(lateResult, { type: 'testBegin' })
    retested = agentDraftReducer(retested, {
      type: 'testEnd', requestId: retested.testRequestId, ok: true, testedFingerprint: 'fp-after', message: 'ok',
    })
    expect(canSaveAgentDraft(retested)).toBe(true)
  })

  it('取消验证后，在途结果不落地且可立即重测', () => {
    let current = state({ phase: 'editing', agentId: 'a', fingerprint: 'fp' })
    current = agentDraftReducer(current, { type: 'testBegin' })
    current = agentDraftReducer(current, { type: 'testCancel' })
    expect(current.phase).toBe('editing')

    // 取消后到达的旧请求结果被丢弃（请求序号已递增）。
    const afterCancel = agentDraftReducer(current, {
      type: 'testEnd', requestId: 1, ok: true, testedFingerprint: 'fp', message: 'late',
    })
    expect(afterCancel).toBe(current)

    // 重测使用新序号并正常落地。
    let retested = agentDraftReducer(current, { type: 'testBegin' })
    retested = agentDraftReducer(retested, {
      type: 'testEnd', requestId: retested.testRequestId, ok: true, testedFingerprint: 'fp', message: 'ok',
    })
    expect(retested.phase).toBe('verified')
    expect(canSaveAgentDraft(retested)).toBe(true)
  })

  it('testing 期间禁止重复发起验证；empty/saving/saved 不接受编辑与验证', () => {
    let current = state({ phase: 'editing', agentId: 'a', fingerprint: 'fp' })
    current = agentDraftReducer(current, { type: 'testBegin' })
    expect(agentDraftReducer(current, { type: 'testBegin' }).testRequestId).toBe(current.testRequestId)

    const empty = initialAgentDraftState()
    expect(agentDraftReducer(empty, edit('fp'))).toBe(empty)
    const saving = state({ phase: 'saving', agentId: 'a', fingerprint: 'fp', verifiedFingerprint: 'fp' })
    expect(agentDraftReducer(saving, edit('fp-new'))).toBe(saving)
    expect(agentDraftReducer(saving, { type: 'testBegin' })).toBe(saving)
  })

  it('保存失败（含 CAS 冲突）回到 verified：草稿与验证保留，可重试保存', () => {
    let current = state({ phase: 'verified', agentId: 'a', fingerprint: 'fp', verifiedFingerprint: 'fp' })
    current = agentDraftReducer(current, { type: 'saveBegin' })
    expect(current.phase).toBe('saving')
    current = agentDraftReducer(current, { type: 'saveEnd', ok: false })
    expect(current.phase).toBe('verified')
    expect(canSaveAgentDraft(current)).toBe(true)

    current = agentDraftReducer(current, { type: 'saveBegin' })
    current = agentDraftReducer(current, { type: 'saveEnd', ok: true })
    expect(current.phase).toBe('saved')
  })

  it('指纹是 name/provider/exe/args 的稳定投影（trim 语义与后端一致）', () => {
    const base = agentDraftFingerprint({ name: 'Peri', provider: 'peri', exe: 'peri', args: ['acp'] })
    expect(agentDraftFingerprint({ name: ' Peri ', provider: 'peri', exe: 'peri', args: ['acp'] })).toBe(base)
    expect(agentDraftFingerprint({ name: 'Peri', provider: '', exe: 'peri', args: ['acp'] })).not.toBe(base)
    expect(agentDraftFingerprint({ name: 'Peri', provider: 'peri', exe: 'peri', args: ['acp', ''] })).not.toBe(base)
  })
})
