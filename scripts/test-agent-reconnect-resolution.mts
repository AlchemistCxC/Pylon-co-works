/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { runReconnectCommand } from '../src/components/settings/reconnectCommand.ts'

const acceptedSnapshots: unknown[] = []
const accepted = await runReconnectCommand({
  reconnect: async () => undefined,
  readSnapshot: async () => { throw new Error('accepted command must not reconcile') },
  applySnapshot: snapshot => { acceptedSnapshots.push(snapshot) },
})
assert.deepEqual(accepted, {})
assert.deepEqual(acceptedSnapshots, [], 'command resolve 只表示请求已接受，不伪造 connected')

const settings = readFileSync(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8')
const reconnectStart = settings.indexOf('  const reconnectAgent = async () => {')
const reloadStart = settings.indexOf('  const reloadAgents = async () => {', reconnectStart)
assert.ok(reconnectStart >= 0, 'reconnectAgent implementation must exist')
assert.ok(reloadStart > reconnectStart, 'reconnectAgent section must be bounded')
const reconnectSection = settings.slice(reconnectStart, reloadStart)

assert.match(reconnectSection, /if \(reconnectPending\) return/)
assert.match(reconnectSection, /setReconnectPending\(true\)/)
assert.match(reconnectSection, /runReconnectCommand\(\{/)
assert.match(reconnectSection, /reconnect: \(\) => agentClient\.reconnectAgent\(\)/)
assert.match(reconnectSection, /readSnapshot: async \(\) => normalizeAgentStatus\(await agentClient\.agentStatus\(\), targetAgent\)/)
assert.match(reconnectSection, /applySnapshot: snapshot => setAgentStatus\(targetAgent, snapshot\)/)
assert.match(reconnectSection, /reportRuntimeError\('重连 Agent', result\.commandError\)/)
assert.doesNotMatch(reconnectSection, /beginReconnect|failReconnect|completeReconnect/)
assert.doesNotMatch(reconnectSection, /setAgentStatus\([^\n]*status:/)

console.log('D-04A reconnect resolve 语义专项测试通过')
