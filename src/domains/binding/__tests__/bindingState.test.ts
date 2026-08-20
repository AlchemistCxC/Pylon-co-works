/**
 * OWNER-03 Binding 状态机纯域单测（方案书 §5.9）。
 *
 * 覆盖：idle 判定 / restore_error 三类不一致（会话缺失、Sheet 归属冲突、activeAgent 冲突）/
 * restoring（状态缺失、connecting、reconnecting）/ binding_ready / agent_disconnected 终态 /
 * 状态文案与锁定判定。
 */
import { describe, expect, it } from 'vitest'
import {
  bindingStatusText,
  isBindingLocked,
  refineBindingGeneration,
  resolveBindingState,
  type BindingResolutionInput,
  type BindingState,
} from '../bindingState'
import type { AgentStatus } from '../../../components/settings/agentTypes'
import type { Session } from '../../../identityStore'

const SESSION: Session = {
  id: 's1', agentId: 'peri', name: 'Demo', source: 'local:demo', profileId: 'profile-a',
  createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
  skills: [], hooks: [], autoName: '',
}

const connected = (status: AgentStatus['status'] = 'connected'): AgentStatus => ({
  agent: 'peri', agentId: 'peri', status, generation: 1, lastConnectedAt: 1,
})

function input(overrides: Partial<BindingResolutionInput> = {}): BindingResolutionInput {
  return {
    activeSheet: { kind: 'agent', agentId: 'peri' },
    activeSessionId: 's1',
    sessions: [SESSION],
    activeAgent: 'peri',
    ownerStatus: connected(),
    ...overrides,
  }
}

describe('resolveBindingState：idle', () => {
  it('无激活 sheet → idle', () => {
    expect(resolveBindingState(input({ activeSheet: null }))).toEqual({ kind: 'idle' })
  })

  it('非 agent sheet（file）→ idle', () => {
    expect(resolveBindingState(input({ activeSheet: { kind: 'file', agentId: 'peri' } }))).toEqual({ kind: 'idle' })
  })

  it('激活会话为空 → idle（InputBar 本就不挂载）', () => {
    expect(resolveBindingState(input({ activeSessionId: null }))).toEqual({ kind: 'idle' })
  })
})

describe('resolveBindingState：restore_error（不猜测）', () => {
  it('agent sheet 缺 agentId → restore_error', () => {
    const state = resolveBindingState(input({ activeSheet: { kind: 'agent' } }))
    expect(state.kind).toBe('restore_error')
    expect(state).toMatchObject({ reason: expect.stringContaining('agentId') })
  })

  it('激活会话在 identity 中不存在 → restore_error', () => {
    const state = resolveBindingState(input({ activeSessionId: 'ghost' }))
    expect(state.kind).toBe('restore_error')
    expect(state).toMatchObject({ agentId: 'peri', reason: expect.stringContaining('不存在') })
  })

  it('会话归属 ≠ Sheet 归属 → restore_error（不猜测）', () => {
    const hermesSession = { ...SESSION, agentId: 'hermes' }
    const state = resolveBindingState(input({ sessions: [hermesSession] }))
    expect(state.kind).toBe('restore_error')
    expect(state).toMatchObject({ agentId: 'peri', reason: expect.stringContaining('hermes') })
  })

  it('activeAgent 与 Sheet 归属冲突 → restore_error', () => {
    const state = resolveBindingState(input({ activeAgent: 'hermes' }))
    expect(state.kind).toBe('restore_error')
    expect(state).toMatchObject({ agentId: 'peri', reason: expect.stringContaining('hermes') })
  })

  it('activeAgent 空串（冷启动未确定）不判冲突', () => {
    const state = resolveBindingState(input({ activeAgent: '' }))
    expect(state.kind).toBe('binding_ready')
  })
})

describe('resolveBindingState：连接确认', () => {
  it('状态快照缺失 → restoring', () => {
    expect(resolveBindingState(input({ ownerStatus: undefined }))).toEqual({ kind: 'restoring', agentId: 'peri' })
  })

  it('connecting / reconnecting → restoring', () => {
    for (const status of ['connecting', 'reconnecting'] as const) {
      expect(resolveBindingState(input({ ownerStatus: connected(status) }))).toEqual({ kind: 'restoring', agentId: 'peri' })
    }
  })

  it('connected → binding_ready', () => {
    expect(resolveBindingState(input())).toEqual({ kind: 'binding_ready', agentId: 'peri', sessionId: 's1' })
  })

  it('disconnected/error/crashed/inactive/unknown → agent_disconnected', () => {
    for (const status of ['disconnected', 'error', 'crashed', 'inactive', 'unknown'] as const) {
      const state = resolveBindingState(input({ ownerStatus: connected(status) }))
      expect(state).toEqual({ kind: 'agent_disconnected', agentId: 'peri', status })
    }
  })
})

describe('isBindingLocked / bindingStatusText', () => {
  it('idle 与 binding_ready 不锁定，其余锁定', () => {
    expect(isBindingLocked({ kind: 'idle' })).toBe(false)
    expect(isBindingLocked({ kind: 'binding_ready', agentId: 'peri', sessionId: 's1' })).toBe(false)
    expect(isBindingLocked({ kind: 'restoring', agentId: 'peri' })).toBe(true)
    expect(isBindingLocked({ kind: 'restore_error', agentId: 'peri', reason: 'x' })).toBe(true)
    expect(isBindingLocked({ kind: 'agent_disconnected', agentId: 'peri', status: 'disconnected' })).toBe(true)
  })

  it('idle/binding_ready 文案为空；锁定态有可读文案', () => {
    expect(bindingStatusText({ kind: 'idle' })).toBe('')
    expect(bindingStatusText({ kind: 'binding_ready', agentId: 'peri', sessionId: 's1' })).toBe('')
    expect(bindingStatusText({ kind: 'restoring', agentId: 'peri' })).toContain('peri')
    expect(bindingStatusText({ kind: 'restore_error', agentId: 'peri', reason: '不一致' })).toContain('不一致')
    expect(bindingStatusText({ kind: 'agent_disconnected', agentId: 'peri', status: 'disconnected' })).toContain('未连接')
    expect(bindingStatusText({ kind: 'binding_stale', agentId: 'peri', sessionId: 's1', fromGeneration: 5, toGeneration: 6 }))
      .toContain('已重连')
  })
})

describe('refineBindingGeneration：binding generation 精化（OWNER-04）', () => {
  const ready = { kind: 'binding_ready', agentId: 'peri', sessionId: 's1' } as const

  it('非 binding_ready 原样透传（不误伤 restoring/error/disconnected/idle）', () => {
    const cases: BindingState[] = [
      { kind: 'idle' },
      { kind: 'restoring', agentId: 'peri' },
      { kind: 'restore_error', agentId: 'peri', reason: 'x' },
      { kind: 'agent_disconnected', agentId: 'peri', status: 'disconnected' },
    ]
    for (const state of cases) {
      expect(refineBindingGeneration(state, { establishedGeneration: 1, currentGeneration: 2 })).toBe(state)
    }
  })

  it('established/current 缺失 → 无法检测陈旧性，保持 binding_ready', () => {
    expect(refineBindingGeneration(ready, { establishedGeneration: undefined, currentGeneration: 5 })).toBe(ready)
    expect(refineBindingGeneration(ready, { establishedGeneration: 5, currentGeneration: undefined })).toBe(ready)
    expect(refineBindingGeneration(ready, { establishedGeneration: undefined, currentGeneration: undefined })).toBe(ready)
  })

  it('established === current → 绑定仍有效', () => {
    expect(refineBindingGeneration(ready, { establishedGeneration: 7, currentGeneration: 7 })).toBe(ready)
  })

  it('established ≠ current → binding_stale（旧 binding 必须 Invalidated）', () => {
    expect(refineBindingGeneration(ready, { establishedGeneration: 5, currentGeneration: 6 })).toEqual({
      kind: 'binding_stale',
      agentId: 'peri',
      sessionId: 's1',
      fromGeneration: 5,
      toGeneration: 6,
    })
  })

  it('binding_stale 计入锁定判定（§5.9 rule 4：重连后不能继续发送旧 remote id）', () => {
    expect(isBindingLocked({
      kind: 'binding_stale', agentId: 'peri', sessionId: 's1', fromGeneration: 5, toGeneration: 6,
    })).toBe(true)
  })

  it('后端 continuity probe 的 probing/detached 健康状态优先锁住旧 binding', () => {
    expect(refineBindingGeneration(ready, {
      establishedGeneration: 5,
      currentGeneration: 6,
      backendHealth: { health: 'probing', agentId: 'peri', source: 'local:s1', generation: 6, retryable: true },
    })).toMatchObject({ kind: 'binding_probing', agentId: 'peri' })
    expect(refineBindingGeneration(ready, {
      establishedGeneration: 5,
      currentGeneration: 6,
      backendHealth: { health: 'detached', agentId: 'peri', source: 'local:s1', generation: 6, reason: 'session-probe-timeout', retryable: true },
    })).toMatchObject({ kind: 'binding_detached', reason: 'session-probe-timeout', retryable: true })
  })
})
