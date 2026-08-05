import { strict as assert } from 'node:assert'
import { normalizeAgentStatus } from '../src/components/settings/agentTypes.ts'

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

console.log('agent contracts（capabilities 透传）守卫通过')
