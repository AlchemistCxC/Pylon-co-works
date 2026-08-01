import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { normalizeAgentStatus, statusLabel } from '../src/components/settings/agentTypes.ts'
import { beginReconnect, completeReconnect, failReconnect, normalizeAgentList } from '../src/components/settings/agentState.ts'

assert.equal(normalizeAgentStatus({ crashed: true }, 'peri').status, 'crashed')
assert.equal(normalizeAgentStatus({ status: 'reconnecting' }, 'peri').status, 'reconnecting')
assert.equal(normalizeAgentStatus({ status: 'connecting' }, 'peri').status, 'connecting')
assert.equal(normalizeAgentStatus({ status: 'inactive' }, 'peri').status, 'inactive')
assert.equal(normalizeAgentStatus({ status: 'unknown' }, 'peri').status, 'error')
assert.match(normalizeAgentStatus({ status: 'unknown' }, 'peri').recentError || '', /未知 Agent 状态/)
assert.equal(normalizeAgentStatus({ status: 'connected', crashed: true }, 'peri').status, 'connected')

const enriched = normalizeAgentStatus({ agentId: 'prism', agent: 'Prism', status: 'connected', generation: 7, lastConnectedAt: 1234 }, 'peri')
assert.equal(enriched.agentId, 'prism')
assert.equal(enriched.agent, 'Prism')
assert.equal(enriched.generation, 7)
assert.equal(enriched.lastConnectedAt, 1234)

assert.equal(statusLabel('connecting'), '连接中')
assert.equal(statusLabel('inactive'), '未激活')
assert.equal(statusLabel('reconnecting'), '重连中')

const initial = { status: 'connected' as const, pending: false }
assert.equal(beginReconnect(initial).status, 'reconnecting')
assert.equal(completeReconnect(beginReconnect(initial)).status, 'connected')
assert.equal(failReconnect(beginReconnect(initial), '失败').error, '失败')
assert.deepEqual(normalizeAgentList([{ id: 'peri', name: 'Peri' }, { id: 1, name: 'bad' }, null]), [{ id: 'peri', name: 'Peri' }])
assert.deepEqual(normalizeAgentList({ agents: [] }), [])

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8')
const runtimeStore = readFileSync(new URL('../src/runtimeStore.ts', import.meta.url), 'utf8')
assert.equal(app.includes("listen<AgentStatusPayload>('peri:agent-status'"), true)
assert.equal(settings.includes("invoke('reconnect_agent')"), true)
assert.equal(settings.includes("invoke('reload_agents')"), true)
assert.equal(runtimeStore.includes('agentStatuses:'), true)

console.log('agent status transaction 回归测试通过')
