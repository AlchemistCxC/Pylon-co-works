import { strict as assert } from 'node:assert'
import { normalizeAgentStatus } from '../src/components/settings/agentTypes.ts'
import { resolveCapabilitySnapshot, resolveAttachGate, resolveAttachFilters } from '../src/infrastructure/acp/agentContracts.ts'

// P2-01：capabilities 原始字段透传——normalize 只搬运不解释，不丢未知键

// 1. capabilities 为对象：内容深相等透传（含嵌套未知键），不断言对象引用相等
const caps = {
  promptImage: false,
  sessionClose: true,
  mcp: { http: true, sse: false },
  fork: null,
  extraUnknownKey: { nested: [1, 2, 3] },
}
const withCaps = normalizeAgentStatus({ agentId: 'peri', status: 'connected', capabilities: caps }, 'fallback')
assert.deepEqual(withCaps.capabilities, caps)
assert.equal(withCaps.agentId, 'peri')
assert.equal(withCaps.status, 'connected')
assert.equal(withCaps.agent, 'fallback')

// 2. capabilities 为 null（断线信号）：原样透传为 null，不得丢弃或替换为 {}
assert.equal(normalizeAgentStatus({ agentId: 'peri', status: 'disconnected', capabilities: null }).capabilities, null)

// 3. capabilities 缺失：结果为 undefined，不得凭空造默认值
assert.equal(normalizeAgentStatus({ agentId: 'peri', status: 'connected' }).capabilities, undefined)

// 4. 未知 status 且携带 capabilities：status 归 error 并带诊断，capabilities 仍透传不丢
const unknownStatus = normalizeAgentStatus({ agentId: 'peri', status: 'weird-status', capabilities: { promptImage: true } }, 'peri')
assert.equal(unknownStatus.status, 'error')
assert.match(unknownStatus.recentError || '', /未知 Agent 状态/)
assert.deepEqual(unknownStatus.capabilities, { promptImage: true })

// 5. crashed 派生路径同样保留 capabilities
assert.equal(normalizeAgentStatus({ agentId: 'peri', crashed: true, capabilities: null }).status, 'crashed')
assert.equal(normalizeAgentStatus({ agentId: 'peri', crashed: true, capabilities: null }).capabilities, null)

// 6. 既有字段行为不回归：transport/cwd/error/generation/lastConnectedAt 照常搬运
const enriched = normalizeAgentStatus(
  { agentId: 'prism', agent: 'Prism', status: 'connected', transport: 'stdio', cwd: '/tmp', error: 'boom', generation: 3, lastConnectedAt: 99, capabilities: { promptImage: true } },
  'peri',
)
assert.equal(enriched.agent, 'Prism')
assert.equal(enriched.transport, 'stdio')
assert.equal(enriched.cwd, '/tmp')
assert.equal(enriched.recentError, 'boom')
assert.equal(enriched.generation, 3)
assert.equal(enriched.lastConnectedAt, 99)
assert.deepEqual(enriched.capabilities, { promptImage: true })

// ===== P2-02：resolveCapabilitySnapshot 快照推导（Peri/Hermes/第三方/null 四样本） =====

const statusOf = (capabilities: unknown | null): Parameters<typeof resolveCapabilitySnapshot>[0] => ({
  agent: 'a',
  agentId: 'a',
  status: 'connected',
  capabilities,
})

// 样本 1：Peri 实测形状（无 authMethods、无 mcpCapabilities、promptCapabilities 空对象）
const peri = resolveCapabilitySnapshot(statusOf({
  loadSession: true,
  promptCapabilities: {},
  sessionCapabilities: { list: true, close: true, resume: true, fork: true },
  _meta: { 'peri.*': true },
}))
assert.deepEqual(peri, {
  connected: true,
  loadSession: true,
  promptImage: false,
  sessionFork: true,
  sessionResume: true,
  sessionClose: true,
  sessionList: true,
  mcpHttp: true,
  mcpSse: true,
  hasAuthMethods: false,
})

// 样本 2：Hermes 实测形状（mcp 显式 false 关闭、authMethods 非空、close 未声明按缺省 true）
const hermes = resolveCapabilitySnapshot(statusOf({
  loadSession: true,
  promptCapabilities: { image: true },
  sessionCapabilities: { fork: true, list: true, resume: true },
  mcpCapabilities: { http: false, sse: false },
  authMethods: ['api_key'],
}))
assert.deepEqual(hermes, {
  connected: true,
  loadSession: true,
  promptImage: true,
  sessionFork: true,
  sessionResume: true,
  sessionClose: true,
  sessionList: true,
  mcpHttp: false,
  mcpSse: false,
  hasAuthMethods: true,
})

// 样本 3：第三方未知 agent 漂移形状——未知键不崩，缺省语义正确
const thirdParty = resolveCapabilitySnapshot(statusOf({
  loadSession: false,
  sessionCapabilities: { fork: true },
  weirdField: { a: 1 },
}))
assert.deepEqual(thirdParty, {
  connected: true,
  loadSession: false,
  promptImage: false,
  sessionFork: true,
  sessionResume: false,
  sessionClose: true,
  sessionList: false,
  mcpHttp: true,
  mcpSse: true,
  hasAuthMethods: false,
})

// 样本 4：capabilities null（断线）→ connected:false + 保守缺省
assert.deepEqual(resolveCapabilitySnapshot(statusOf(null)), {
  connected: false,
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

// 边界：status 整体缺失（hook 初始态）与 null 同语义；空对象不断线
assert.deepEqual(resolveCapabilitySnapshot(undefined).connected, false)
assert.deepEqual(resolveCapabilitySnapshot(null).connected, false)
assert.deepEqual(resolveCapabilitySnapshot(statusOf({})), {
  connected: true,
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

// 缺省 vs 显式：sessionClose 显式 false 才关；mcp 显式 false 才关，显式 true 保持 true
assert.deepEqual(resolveCapabilitySnapshot(statusOf({
  sessionCapabilities: { close: false },
  mcpCapabilities: { http: false, sse: true },
})), {
  connected: true,
  loadSession: false,
  promptImage: false,
  sessionFork: false,
  sessionResume: false,
  sessionClose: false,
  sessionList: false,
  mcpHttp: false,
  mcpSse: true,
  hasAuthMethods: false,
})

// authMethods 非数组（漂移）不当 hasAuthMethods
assert.equal(resolveCapabilitySnapshot(statusOf({ authMethods: 'api_key' })).hasAuthMethods, false)

// ===== P2-03：附件入口能力降级（gate + filters 三态） =====

// 态 1：capabilities null（未连接）→ 状态拦截，不放行
const notConnected = resolveCapabilitySnapshot(statusOf(null))
assert.deepEqual(resolveAttachGate(notConnected), { allowed: false, reason: 'Agent 未连接，附件暂不可用' })

// 态 2：connected 且 promptImage=false → 放行 + accept 仅文本
const textOnly = resolveCapabilitySnapshot(statusOf({ promptCapabilities: {} }))
assert.deepEqual(resolveAttachGate(textOnly), { allowed: true })
const textFilters = resolveAttachFilters(textOnly)
assert.equal(textFilters.length, 1)
assert.equal(textFilters[0].name, '文本')
assert.equal(textFilters[0].extensions.includes('png'), false, '无图片能力时 filters 不得含图片')

// 态 3：connected 且 promptImage=true → 放行 + accept 图片+文本
const imageOk = resolveCapabilitySnapshot(statusOf({ promptCapabilities: { image: true } }))
assert.deepEqual(resolveAttachGate(imageOk), { allowed: true })
const imageFilters = resolveAttachFilters(imageOk)
assert.equal(imageFilters.length, 2)
assert.equal(imageFilters.some(f => f.name === '图片' && f.extensions.includes('png')), true, '有图片能力时 filters 必须含图片')

// gate 对缺失快照（status 整体缺失）同样拦截
assert.equal(resolveAttachGate(resolveCapabilitySnapshot(undefined)).allowed, false)

console.log('agent contracts（capabilities 透传 + 快照推导 + 附件降级）守卫通过')
