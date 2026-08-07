/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  beginReconnect,
  completeReconnect,
  failReconnect,
  type AgentStatusTransactionState,
} from '../src/components/settings/agentState.ts'

const settings = readFileSync(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8')
const agentState = readFileSync(new URL('../src/components/settings/agentState.ts', import.meta.url), 'utf8')

// The reconnect command is deliberately checked without assuming any agent-id
// payload: the production command is the active-agent transaction's command.
assert.match(settings, /const reconnectAgent = async \(\) => \{[\s\S]*?if \(reconnecting\) return/)
assert.match(settings, /setReconnecting\(true\)/)
assert.match(settings, /setAgentStatus\(activeAgent, \{ \.\.\.beginReconnect\(\{ \.\.\.currentStatus, pending: false \}\), agent: activeAgent \}\)/)
assert.match(settings, /await invoke\('reconnect_agent'\)/)
assert.match(settings, /setAgentStatus\(activeAgent, \{ \.\.\.failReconnect\(\{ \.\.\.currentStatus, pending: false \}, detail\.message\), agent: activeAgent \}\)/)
assert.match(settings, /finally \{ setReconnecting\(false\) \}/)
assert.match(settings, /disabled=\{reconnecting\}/)
assert.match(agentState, /status: 'reconnecting', pending: true, error: undefined/)
assert.match(agentState, /status: 'connected', pending: false, error: undefined/)
assert.match(agentState, /status: 'error', pending: false, error/)

const idle: AgentStatusTransactionState = {
  status: 'connected',
  pending: false,
  error: 'stale error',
}

// A minimal harness models the component's guard, status updates, command and
// finally behavior while using the real dependency-free transaction helpers.
async function runReconnect(
  state: AgentStatusTransactionState,
  command: () => Promise<unknown>,
  setStatus: (next: AgentStatusTransactionState) => void,
  getPending: () => boolean,
  setPending: (value: boolean) => void,
  report: (error: unknown) => string,
): Promise<boolean> {
  if (getPending()) return false
  setPending(true)
  setStatus(beginReconnect({ ...state, pending: false }))
  try {
    await command()
  } catch (error) {
    setStatus(failReconnect({ ...state, pending: false }, report(error)))
  } finally {
    setPending(false)
  }
  return true
}

let state = idle
let pending = false
let calls = 0
const setStatus = (next: AgentStatusTransactionState) => { state = next }
const setPending = (value: boolean) => { pending = value }
const report = (error: unknown) => error instanceof Error ? error.message : String(error)

let release!: () => void
const blocked = new Promise<void>(resolve => { release = resolve })
const first = runReconnect(state, async () => {
  calls += 1
  await blocked
}, setStatus, () => pending, setPending, report)

await Promise.resolve()
assert.equal(pending, true, 'reconnect sets the pending guard')
assert.equal(state.status, 'reconnecting', 'idle/connected enters reconnecting')
assert.equal(state.pending, true)
assert.equal(state.error, undefined)
assert.equal(await runReconnect(state, async () => { calls += 1 }, setStatus, () => pending, setPending, report), false, 'duplicate reconnect is guarded')
assert.equal(calls, 1)
release()
assert.equal(await first, true)
assert.equal(pending, false, 'finally restores the pending guard')

state = completeReconnect(state)
assert.deepEqual(state, { status: 'connected', pending: false, error: undefined })

state = idle
pending = false
let rejectedCalls = 0
assert.equal(await runReconnect(state, async () => {
  rejectedCalls += 1
  throw new Error('command rejected')
}, setStatus, () => pending, setPending, report), true)
assert.equal(rejectedCalls, 1)
assert.deepEqual(state, { status: 'error', pending: false, error: 'command rejected' })
assert.equal(pending, false, 'reject path also restores the pending guard in finally')

console.log('agent reconnect transaction 回归测试通过')
