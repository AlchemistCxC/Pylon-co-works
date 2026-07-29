import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  beginReconnect,
  completeReconnect,
  failReconnect,
  resolveReconnectCommandFailure,
} from '../src/components/settings/agentState.ts'

const connected = { status: 'connected' as const, pending: false }

// The reconnect transaction enters an explicit pending state before invoking the command.
const reconnecting = beginReconnect(connected)
assert.equal(reconnecting.status, 'reconnecting')
assert.equal(reconnecting.pending, true)
assert.equal(reconnecting.error, undefined)

// A command resolve only means that the request was accepted; it must not be treated as
// the authoritative connected status. The connected transition remains event-driven.
assert.equal(completeReconnect(reconnecting).status, 'connected')
assert.equal(completeReconnect(reconnecting).pending, false)

// A rejected reconnect command is the only command-path transition into error.
const commandFailure = resolveReconnectCommandFailure(reconnecting, '连接失败')
assert.equal(commandFailure.status, 'error')
assert.equal(commandFailure.pending, false)
assert.equal(commandFailure.error, '连接失败')
assert.deepEqual(failReconnect(reconnecting, '连接失败'), commandFailure)

const settings = readFileSync(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8')
const reconnectStart = settings.indexOf('  const reconnectAgent = async () => {')
const reloadStart = settings.indexOf('  const reloadAgents = async () => {', reconnectStart)
assert.ok(reconnectStart >= 0, 'reconnectAgent implementation must exist')
assert.ok(reloadStart > reconnectStart, 'reconnectAgent section must be bounded')
const reconnectSection = settings.slice(reconnectStart, reloadStart)

assert.match(reconnectSection, /if \(reconnecting\) return/)
assert.match(reconnectSection, /setReconnecting\(true\)/)
assert.match(reconnectSection, /beginReconnect\(/)
assert.match(reconnectSection, /await invoke\('reconnect_agent'\)/)
assert.match(reconnectSection, /finally \{ setReconnecting\(false\) \}/)

const tryStart = reconnectSection.indexOf('    try {')
const catchStart = reconnectSection.indexOf('    } catch (error) {', tryStart)
assert.ok(tryStart >= 0 && catchStart > tryStart, 'reconnect command try/catch must exist')
const commandResolvePath = reconnectSection.slice(tryStart, catchStart)
assert.doesNotMatch(commandResolvePath, /setAgentStatus\([^\n]*status:\s*['"]connected['"]/)
assert.doesNotMatch(commandResolvePath, /completeReconnect\(/)
assert.match(commandResolvePath, /await invoke\('reconnect_agent'\)/)

const commandFailurePath = reconnectSection.slice(catchStart)
assert.match(commandFailurePath, /reportRuntimeError\('重连 Agent', error\)/)
assert.match(commandFailurePath, /failReconnect\(/)
assert.match(commandFailurePath, /agent: activeAgent/)

// The source contract must retain the explicit semantic distinction: command resolve is
// accepted, while the real peri:agent-status event is responsible for completion elsewhere.
assert.match(reconnectSection, /command resolve 只代表请求已接受/)
assert.doesNotMatch(reconnectSection, /completeReconnect\(/)

console.log('D-04A reconnect resolve 语义专项测试通过')
