import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { normalizeAgentStatus, statusLabel } from '../src/components/settings/agentTypes.ts'
import { beginReconnect, completeReconnect, failReconnect } from '../src/components/settings/agentState.ts'

assert.equal(normalizeAgentStatus({ crashed: true }, 'peri').status, 'crashed')
assert.equal(normalizeAgentStatus({ status: 'reconnecting' }, 'peri').status, 'reconnecting')
assert.equal(normalizeAgentStatus({}, 'peri').status, 'connected')
assert.equal(statusLabel('connected'), '已连接')

const initial = { status: 'connected' as const, pending: false }
assert.equal(beginReconnect(initial).status, 'reconnecting')
assert.equal(completeReconnect(beginReconnect(initial)).status, 'connected')
assert.equal(failReconnect(beginReconnect(initial), '失败').error, '失败')

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8')
const store = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
assert.equal(app.includes("listen<AgentStatusPayload>('peri:agent-status'"), true)
assert.equal(settings.includes("invoke('reconnect_agent')"), true)
assert.equal(settings.includes("invoke('reload_agents')"), true)
assert.equal(store.includes('agentStatuses:'), true)

console.log('agent status transaction 回归测试通过')
