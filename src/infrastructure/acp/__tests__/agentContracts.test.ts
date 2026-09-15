import { describe, expect, it } from 'vitest'
import { resolveCapabilitySnapshot, resolveAttachGate, resolveAttachFilters } from '../agentContracts'
import { normalizeAgentList } from '../agentClient.ts'
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
    // #98：raw 兜底 fail-closed——fork 无消费者登记信息恒 false（ghost 防线）；
    // mcp 缺省 true 已废除，显式 false 才有值。
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
      sessionFork: false,
      mcpHttp: false,
      mcpSse: false,
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
        sessionClose: false,
        sessionList: false,
        mcpHttp: false,
        mcpSse: false,
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

describe('normalizeAgentList invocation contract', () => {
  it('preserves structured arguments and rejects a corrupt argument field without splitting strings', () => {
    expect(normalizeAgentList([
      {
        id: 'valid',
        name: 'Valid',
        args: ['--profile', 'work space', '', 'a"b'],
        effectiveArgs: ['--profile', 'work space', '', 'a"b', '--model', 'demo'],
      },
      { id: 'corrupt', name: 'Corrupt', args: ['ok', 42], effectiveArgs: 'not-an-array' },
    ])).toEqual([
      expect.objectContaining({
        id: 'valid',
        args: ['--profile', 'work space', '', 'a"b'],
        effectiveArgs: ['--profile', 'work space', '', 'a"b', '--model', 'demo'],
      }),
      expect.objectContaining({ id: 'corrupt', args: undefined, effectiveArgs: undefined }),
    ])
  })
})

// ── 迁移自 scripts/test-agent-contracts.mts（P91 A1）：先读既有用例查重后仅迁缺失段——
// 四个实测样本的完整 11 键深相等、空对象 capabilities 语义、显式 vs 缺省、authMethods 漂移、
// 图片 filters 完整性（长度 + png 扩展）与 gate 对缺失快照的拦截；
// 旧代际 connected=false、undefined/null 初始态、附件 gate/filters 三态主干已由上方用例覆盖，不再重复。──
describe('resolveCapabilitySnapshot — 实测样本完整快照（迁移自 scripts/test-agent-contracts.mts，P91 A1；#98 fail-closed 语义更新）', () => {
  it('样本 1：Peri 实测形状（根级 loadSession alias 生效；嵌套布尔不算 object capability；fork raw 无消费者恒 false）', () => {
    expect(resolveCapabilitySnapshot(status({
      capabilities: {
        loadSession: true,
        promptCapabilities: {},
        sessionCapabilities: { list: true, close: true, resume: true, fork: true },
        _meta: { 'peri.*': true },
      },
    }))).toEqual({
      connected: true,
      capabilitiesKnown: true,
      loadSession: true,
      promptImage: false,
      sessionFork: false,
      sessionResume: false,
      sessionClose: true,
      sessionList: true,
      mcpHttp: false,
      mcpSse: false,
      hasAuthMethods: false,
    })
  })

  it('样本 2：Hermes 实测形状（mcp 显式 false 关闭、authMethods 非空、close 未声明按 fail-closed 关）', () => {
    expect(resolveCapabilitySnapshot(status({
      capabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { fork: true, list: true, resume: true },
        mcpCapabilities: { http: false, sse: false },
        authMethods: ['api_key'],
      },
    }))).toEqual({
      connected: true,
      capabilitiesKnown: true,
      loadSession: true,
      promptImage: true,
      sessionFork: false,
      sessionResume: false,
      sessionClose: false,
      sessionList: true,
      mcpHttp: false,
      mcpSse: false,
      hasAuthMethods: true,
    })
  })

  it('样本 3：第三方未知 agent 漂移形状——未知键不崩，缺省语义 fail-closed', () => {
    expect(resolveCapabilitySnapshot(status({
      capabilities: {
        loadSession: false,
        sessionCapabilities: { fork: true },
        weirdField: { a: 1 },
      },
    }))).toEqual({
      connected: true,
      capabilitiesKnown: true,
      loadSession: false,
      promptImage: false,
      sessionFork: false,
      sessionResume: false,
      sessionClose: false,
      sessionList: false,
      mcpHttp: false,
      mcpSse: false,
      hasAuthMethods: false,
    })
  })

  it('样本 4：capabilities null 的完整 11 键快照（生命周期 connected 但能力未确认）', () => {
    expect(resolveCapabilitySnapshot(status({ capabilities: null }))).toEqual({
      connected: true,
      capabilitiesKnown: false,
      loadSession: false,
      promptImage: false,
      sessionFork: false,
      sessionResume: false,
      sessionClose: false,
      sessionList: false,
      mcpHttp: false,
      mcpSse: false,
      hasAuthMethods: false,
    })
  })

  it('空对象 capabilities：不断线且能力已确认（区别于缺失 capabilities 的未确认语义）', () => {
    expect(resolveCapabilitySnapshot(status({ capabilities: {} }))).toEqual({
      connected: true,
      capabilitiesKnown: true,
      loadSession: false,
      promptImage: false,
      sessionFork: false,
      sessionResume: false,
      sessionClose: false,
      sessionList: false,
      mcpHttp: false,
      mcpSse: false,
      hasAuthMethods: false,
    })
  })

  it('缺省 vs 显式：object capability 只认 object 值；close/mcp 显式值原样投影（true 即 true）', () => {
    expect(resolveCapabilitySnapshot(status({
      capabilities: {
        sessionCapabilities: { close: false, resume: {}, loadSession: {} },
        mcpCapabilities: { http: false, sse: true },
      },
    }))).toEqual({
      connected: true,
      capabilitiesKnown: true,
      loadSession: true,
      promptImage: false,
      sessionFork: false,
      sessionResume: true,
      sessionClose: false,
      sessionList: false,
      mcpHttp: false,
      mcpSse: true,
      hasAuthMethods: false,
    })
  })

  it('authMethods 非数组（漂移）不当 hasAuthMethods', () => {
    expect(resolveCapabilitySnapshot(status({ capabilities: { authMethods: 'api_key' } })).hasAuthMethods).toBe(false)
  })
})

describe('resolveAttachFilters/gate — 图片 filters 完整性与缺失快照（迁移自 scripts/test-agent-contracts.mts，P91 A1）', () => {
  it('connected + promptImage=true → filters 恰为 2 且图片含 png 扩展（态 4 补遗）', () => {
    const imageOk = resolveCapabilitySnapshot(status({ capabilities: { promptCapabilities: { image: true } } }))
    const imageFilters = resolveAttachFilters(imageOk)
    expect(imageFilters.length).toBe(2)
    expect(imageFilters.some(f => f.name === '图片' && f.extensions.includes('png'))).toBe(true)
  })

  it('gate 对缺失快照（status 整体缺失）同样拦截', () => {
    expect(resolveAttachGate(resolveCapabilitySnapshot(undefined)).allowed).toBe(false)
  })
})

// ── #98：结构化三层协商快照（capabilitySnapshot）——Rust/IPC/TS 一致投影 ──
describe('resolveCapabilitySnapshot — 结构化 capabilitySnapshot（#98 AC6/AC13）', () => {
  /** 与 Rust NegotiatedCapabilitySnapshot::wire_value 同构的 fixture。 */
  const wireSnapshot = (capabilities: Record<string, unknown>, generation = 7) => ({
    generation,
    capabilities,
  })

  it('usable 三层投影：load/resume/close/mcp 按 usable 键逐条映射', () => {
    expect(resolveCapabilitySnapshot(status({
      capabilities: { loadSession: 'stale-raw' },
      capabilitySnapshot: wireSnapshot({
        load: { fact: 'usable', source: 'canonical', advertised: true, negotiated: true, usable: true, diagnostics: [] },
        resume: { fact: 'usable', source: 'canonical', advertised: true, negotiated: true, usable: true, diagnostics: [] },
        fork: { fact: 'advertised', source: 'canonical', advertised: true, negotiated: true, usable: false, diagnostics: ['capability \'fork\': 已广告但消费者未注册，不可 usable'] },
        close: { fact: 'unknown', source: 'none', advertised: false, negotiated: false, usable: false, diagnostics: [] },
        list: { fact: 'unknown', source: 'none', advertised: false, negotiated: false, usable: false, diagnostics: [] },
        promptImage: { fact: 'usable', source: 'canonical', advertised: true, negotiated: true, usable: true, diagnostics: [] },
        mcpHttp: { fact: 'usable', source: 'canonical', advertised: true, negotiated: true, usable: true, diagnostics: [] },
        mcpSse: { fact: 'unknown', source: 'none', advertised: false, negotiated: false, usable: false, diagnostics: [] },
        elicitation: { fact: 'usable', source: 'host', advertised: null, negotiated: true, usable: true, diagnostics: [] },
      }),
    }))).toEqual({
      connected: true,
      capabilitiesKnown: true,
      loadSession: true,
      promptImage: true,
      sessionFork: false,
      sessionResume: true,
      sessionClose: false,
      sessionList: false,
      mcpHttp: true,
      mcpSse: false,
      hasAuthMethods: false,
    })
  })

  it('AC7：fork 已广告但未注册消费者 → 快照 usable=false 压过 raw 的 fork:true（ghost 防线在权威路径同样成立）', () => {
    expect(resolveCapabilitySnapshot(status({
      capabilities: { sessionCapabilities: { fork: true } },
      capabilitySnapshot: wireSnapshot({
        fork: { fact: 'negotiated', source: 'canonical', advertised: true, negotiated: true, usable: false, diagnostics: [] },
      }),
    })).sessionFork).toBe(false)
  })

  it('快照键缺失/非法形状 → fail-closed false；快照存在时覆盖 raw 推导', () => {
    const snapshot = resolveCapabilitySnapshot(status({
      capabilities: { loadSession: true },
      capabilitySnapshot: wireSnapshot({
        // 只登记 load：其余条目缺失 → false（不回退 raw，不做缺省 true）。
        load: { fact: 'usable', advertised: true, negotiated: true, usable: true },
      }),
    }))
    expect(snapshot.loadSession).toBe(true)
    expect(snapshot.sessionFork).toBe(false)
    expect(snapshot.sessionClose).toBe(false)
    expect(snapshot.mcpHttp).toBe(false)
  })

  it('root-alias 来源（诊断可见）不影响投影——alias 生效即 usable=true', () => {
    expect(resolveCapabilitySnapshot(status({
      capabilities: { loadSession: true },
      capabilitySnapshot: wireSnapshot({
        load: { fact: 'usable', source: 'root-alias', advertised: true, negotiated: true, usable: true, diagnostics: ['capability \'load\': 根级 alias loadSession 生效（兼容形状，计划弃用）'] },
      }),
    })).loadSession).toBe(true)
  })

  it('非法 capabilitySnapshot 形状 → 回落 raw 兜底（不崩溃、不误 true）', () => {
    expect(resolveCapabilitySnapshot(status({
      capabilities: { loadSession: true },
      capabilitySnapshot: 'corrupt' as unknown,
    })).loadSession).toBe(true)
    expect(resolveCapabilitySnapshot(status({
      capabilities: null,
      capabilitySnapshot: 42 as unknown,
    })).sessionFork).toBe(false)
  })
})
