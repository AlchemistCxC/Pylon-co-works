import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { normalizeAgentList } from '../src/components/settings/agentState.ts'

const settings = readFileSync(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8')
const agentState = readFileSync(new URL('../src/components/settings/agentState.ts', import.meta.url), 'utf8')

const reloadStart = settings.indexOf('  const reloadAgents = async () => {')
const reloadEnd = settings.indexOf('\n  }\n\n  return (', reloadStart)
assert.ok(reloadStart >= 0, 'Settings must define reloadAgents')
assert.ok(reloadEnd > reloadStart, 'reloadAgents source section must be bounded')
const reloadSource = settings.slice(reloadStart, reloadEnd)

const callOrder = [
  "invoke('reload_agents')",
  "invoke<unknown>('list_agents')",
  'useStore.getState().setAgents(normalizeAgentList(list))',
]
let previous = -1
for (const token of callOrder) {
  const index = reloadSource.indexOf(token)
  assert.ok(index > previous, `reload transaction order must include ${token}`)
  previous = index
}
assert.match(reloadSource, /setReloading\(true\)/)
assert.match(reloadSource, /finally\s*\{\s*setReloading\(false\)\s*\}/)
assert.match(reloadSource, /catch\s*\(error\)[\s\S]*reportRuntimeError\('重载 Agent 配置', error\)/)
assert.doesNotMatch(reloadSource, /setActiveAgent|setAgentStatus/)
assert.match(agentState, /export function normalizeAgentList\(value: unknown\)/)

async function runReloadTransaction({
  invoke,
  initialAgents,
  setAgents,
  reportError,
}: {
  invoke: (command: string) => Promise<unknown>
  initialAgents: { id: string; name: string }[]
  setAgents: (agents: { id: string; name: string }[]) => void
  reportError: (error: unknown) => void
}) {
  let reloading = false
  let agents = initialAgents
  const getAgents = () => agents
  const store = { getState: () => ({ setAgents: (next: { id: string; name: string }[]) => { agents = next } }) }
  const setReloading = (value: boolean) => { reloading = value }

  if (reloading) return
  setReloading(true)
  try {
    await invoke('reload_agents')
    const list = await invoke('list_agents')
    const normalized = normalizeAgentList(list)
    store.getState().setAgents(normalized)
    setAgents(normalized)
  } catch (error) {
    reportError(error)
  } finally {
    setReloading(false)
  }
  return { getAgents, isReloading: () => reloading }
}

const calls: string[] = []
let committed: { id: string; name: string }[] = [{ id: 'old', name: 'Old Agent' }]
const successful = await runReloadTransaction({
  initialAgents: committed,
  invoke: async command => {
    calls.push(command)
    if (command === 'reload_agents') return { accepted: true }
    return [
      { id: 'peri', name: 'Peri' },
      { id: 42, name: 'invalid id' },
      { id: 'bad-name', name: 7 },
      null,
      { id: 'worker', name: 'Worker' },
    ]
  },
  setAgents: next => { committed = next },
  reportError: () => assert.fail('successful reload must not report an error'),
})
assert.deepEqual(calls, ['reload_agents', 'list_agents'])
assert.deepEqual(committed, [
  { id: 'peri', name: 'Peri' },
  { id: 'worker', name: 'Worker' },
])
assert.equal(successful?.isReloading(), false, 'loading must be cleared after success')

let errorCalls = 0
const oldAgents = [{ id: 'old', name: 'Old Agent' }]
const failed = await runReloadTransaction({
  initialAgents: oldAgents,
  invoke: async command => {
    if (command === 'reload_agents') throw new Error('reload failed')
    return []
  },
  setAgents: () => assert.fail('failed reload must retain the old list'),
  reportError: error => {
    errorCalls += 1
    assert.equal((error as Error).message, 'reload failed')
  },
})
assert.deepEqual(failed?.getAgents(), oldAgents)
assert.equal(errorCalls, 1)
assert.equal(failed?.isReloading(), false, 'loading must be cleared after failure')

let listFailureCalls = 0
const listFailed = await runReloadTransaction({
  initialAgents: oldAgents,
  invoke: async command => {
    if (command === 'list_agents') throw new Error('list failed')
    return { accepted: true }
  },
  setAgents: () => assert.fail('list failure must retain the old list'),
  reportError: error => {
    listFailureCalls += 1
    assert.equal((error as Error).message, 'list failed')
  },
})
assert.deepEqual(listFailed?.getAgents(), oldAgents)
assert.equal(listFailureCalls, 1)
assert.equal(listFailed?.isReloading(), false, 'loading must be cleared after list failure')

assert.deepEqual(normalizeAgentList(undefined), [])
assert.deepEqual(normalizeAgentList({ agents: [{ id: 'nested', name: 'Not a list' }] }), [])

console.log('agent reload transaction 回归测试通过')
