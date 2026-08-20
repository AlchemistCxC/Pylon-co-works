/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { runReconnectCommand } from '../src/components/settings/reconnectCommand.ts'
import { shouldAcceptAgentStatus, type AgentStatus } from '../src/components/settings/agentTypes.ts'

const settings = readFileSync(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8')

assert.match(settings, /const reconnectAgent = async \(\) => \{[\s\S]*?if \(reconnectPending\) return/)
assert.match(settings, /setReconnectPending\(true\)/)
assert.match(settings, /runReconnectCommand\(\{/)
assert.match(settings, /readSnapshot: async \(\) => normalizeAgentStatus\(await agentClient\.agentStatus\(\), targetAgent\)/)
assert.match(settings, /applySnapshot: snapshot => setAgentStatus\(targetAgent, snapshot\)/)
assert.match(settings, /setReconnectCommandError\(detail\.message\)/)
assert.match(settings, /disabled=\{reconnectPending\}/)
assert.equal(settings.includes('beginReconnect'), false, 'Settings 不得伪造 reconnecting lifecycle')
assert.equal(settings.includes('failReconnect'), false, 'Settings catch 不得伪造 error lifecycle')

let lifecycle: AgentStatus = {
  agent: 'peri',
  agentId: 'peri',
  status: 'connected',
  generation: 3,
  capabilities: { promptCapabilities: { image: true } },
}

let rejectCommand!: (error: unknown) => void
const command = new Promise<never>((_resolve, reject) => { rejectCommand = reject })
const pending = runReconnectCommand({
  reconnect: () => command,
  readSnapshot: async () => ({
    agent: 'peri',
    agentId: 'peri',
    status: 'disconnected',
    generation: 4,
    capabilities: null,
  }),
  applySnapshot: snapshot => { lifecycle = snapshot },
})

await Promise.resolve()
assert.equal(lifecycle.status, 'connected', 'command pending 不得覆盖最后权威 lifecycle')
rejectCommand(new Error('command rejected'))
const rejected = await pending
assert.equal((rejected.commandError as Error).message, 'command rejected')
assert.equal(lifecycle.status, 'disconnected', 'command reject 后必须应用 agent_status 权威快照')
assert.equal(lifecycle.generation, 4)
assert.equal(lifecycle.capabilities, null, '不得把旧 capabilities 展开进新快照')

const lastAuthoritative = lifecycle
const failedReconciliation = await runReconnectCommand({
  reconnect: async () => { throw new Error('command rejected again') },
  readSnapshot: async () => { throw new Error('status unavailable') },
  applySnapshot: snapshot => { lifecycle = snapshot },
})
assert.equal((failedReconciliation.reconciliationError as Error).message, 'status unavailable')
assert.equal(lifecycle, lastAuthoritative, '快照查询失败时必须保留最后权威 lifecycle')

assert.equal(shouldAcceptAgentStatus(
  { agent: 'peri', status: 'connected', generation: 4 },
  { agent: 'peri', status: 'reconnecting', generation: 3 },
), false, '旧 generation 事件不得覆盖新 runtime 快照')
assert.equal(shouldAcceptAgentStatus(
  { agent: 'peri', status: 'reconnecting', generation: 4 },
  { agent: 'peri', status: 'connected', generation: 4 },
), true, '同 generation 仍按事件到达顺序更新')

console.log('agent reconnect command/lifecycle 分离回归测试通过')
