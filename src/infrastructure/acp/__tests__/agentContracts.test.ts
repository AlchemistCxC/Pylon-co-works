import { describe, expect, it } from 'vitest'
import { resolveCapabilitySnapshot, resolveAttachGate, resolveAttachFilters } from '../agentContracts'
import type { AgentStatus } from '../../../components/settings/agentTypes'

function status(partial: Partial<AgentStatus>): AgentStatus {
  return {
    agent: 'peri',
    status: 'connected',
    ...partial,
  }
}

describe('resolveCapabilitySnapshot lifecycle/capabilities contract', () => {
  it('connected without negotiated capabilities remains connected and reports unknown negotiation', () => {
    expect(resolveCapabilitySnapshot(status({ capabilities: null }))).toMatchObject({
      connected: true,
      capabilitiesKnown: false,
    })
    expect(resolveCapabilitySnapshot(status({}))).toMatchObject({
      connected: true,
      capabilitiesKnown: false,
    })
  })

  it('connected with object capabilities reports negotiated and derives capability flags', () => {
    expect(resolveCapabilitySnapshot(status({
      capabilities: {
        promptCapabilities: { image: true },
        sessionCapabilities: { fork: true },
        mcpCapabilities: { http: false },
      },
    }))).toMatchObject({
      connected: true,
      capabilitiesKnown: true,
      promptImage: true,
      sessionFork: true,
      mcpHttp: false,
    })
  })

  it('non-connected lifecycle never inherits connected from stale capabilities', () => {
    expect(resolveCapabilitySnapshot(status({
      status: 'reconnecting',
      capabilities: { promptCapabilities: { image: true } },
    }))).toMatchObject({ connected: false, capabilitiesKnown: true, promptImage: true })
    expect(resolveCapabilitySnapshot(status({
      status: 'error',
      capabilities: { promptCapabilities: { image: true } },
    })).connected).toBe(false)
  })

  it.each(['connecting', 'reconnecting', 'disconnected', 'crashed', 'error', 'inactive', 'unknown'] as const)(
    '旧代际：status %s 携带旧 capabilities 对象 → connected=false',
    (s) => {
      expect(resolveCapabilitySnapshot(status({
        status: s,
        capabilities: { promptCapabilities: { image: true } },
      })).connected).toBe(false)
    },
  )

  it('缺失 status（hook 初始态 undefined/null）→ connected=false', () => {
    expect(resolveCapabilitySnapshot(undefined).connected).toBe(false)
    expect(resolveCapabilitySnapshot(null).connected).toBe(false)
  })

  it.each(['string-caps', [1, 2], 42, true] as const)(
    '非法 capabilities 形状 %p → capabilitiesKnown=false 且保守缺省，不崩溃',
    (caps) => {
      const snapshot = resolveCapabilitySnapshot(status({ capabilities: caps as unknown }))
      expect(snapshot).toMatchObject({
        connected: true,
        capabilitiesKnown: false,
        loadSession: false,
        promptImage: false,
        sessionFork: false,
        sessionResume: false,
        sessionClose: true,
        sessionList: false,
        mcpHttp: true,
        mcpSse: true,
        hasAuthMethods: false,
      })
    },
  )

  it('非 connected + 非法 capabilities 形状 → connected=false 且能力缺省', () => {
    const snapshot = resolveCapabilitySnapshot(status({
      status: 'reconnecting',
      capabilities: 'stale-string' as unknown,
    }))
    expect(snapshot).toMatchObject({ connected: false, capabilitiesKnown: false, promptImage: false })
  })
})

describe('resolveAttachGate / resolveAttachFilters 附件入口 gate', () => {
  it('非 connected 生命周期即使携带旧 capabilities 也拦截', () => {
    const notConnected = resolveCapabilitySnapshot(status({
      status: 'reconnecting',
      capabilities: { promptCapabilities: { image: true } },
    }))
    expect(resolveAttachGate(notConnected)).toEqual({ allowed: false, reason: 'Agent 未连接，附件暂不可用' })
  })

  it('connected + 能力未确认 → 放行文本附件，图片保守关闭', () => {
    const unknown = resolveCapabilitySnapshot(status({ capabilities: null }))
    expect(resolveAttachGate(unknown)).toEqual({ allowed: true })
    const filters = resolveAttachFilters(unknown)
    expect(filters.some(f => f.name === '图片')).toBe(false)
    expect(filters.some(f => f.name === '文本')).toBe(true)
  })

  it('connected + promptImage=true → accept 含图片+文本', () => {
    const imageOk = resolveCapabilitySnapshot(status({
      capabilities: { promptCapabilities: { image: true } },
    }))
    expect(resolveAttachGate(imageOk)).toEqual({ allowed: true })
    expect(resolveAttachFilters(imageOk).some(f => f.name === '图片')).toBe(true)
  })

  it('connected + promptImage 未声明 → accept 仅文本', () => {
    const textOnly = resolveCapabilitySnapshot(status({
      capabilities: { promptCapabilities: {} },
    }))
    expect(resolveAttachGate(textOnly)).toEqual({ allowed: true })
    const filters = resolveAttachFilters(textOnly)
    expect(filters.length).toBe(1)
    expect(filters[0]?.name).toBe('文本')
    expect(filters[0]?.extensions.includes('png')).toBe(false)
  })
})
