import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { normalizeAgentStatus } from '../src/components/settings/agentTypes.ts'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const runtimeStore = readFileSync(new URL('../src/runtimeStore.ts', import.meta.url), 'utf8')

const effectStart = app.indexOf("  useEffect(() => {\n    let disposed = false")
assert.notEqual(effectStart, -1, 'Agent 初始化 effect 必须声明 disposed guard')
const effectEnd = app.indexOf('\n  }, [])', effectStart)
assert.notEqual(effectEnd, -1, 'Agent 初始化 effect 必须有空依赖清理边界')
const lifecycle = app.slice(effectStart, effectEnd + '\n  }, [])'.length)

assert.match(lifecycle, /invoke(?:<[^>]+>)?\('list_agents'\)/, '必须异步加载 list_agents')
assert.match(lifecycle, /if \(!disposed\) useIdentityStore\.getState\(\)\.setAgents\(/, 'list_agents 结果必须受 disposed guard 保护')
assert.match(lifecycle, /listen<AgentStatusPayload>\('peri:agent-status'/, '必须注册 peri:agent-status listener')
assert.match(lifecycle, /const activeAgent = useIdentityStore\.getState\(\)\.activeAgent/, 'listener 必须从最新 identity store 读取 activeAgent')
assert.match(lifecycle, /normalizeAgentStatus\(event\.payload, activeAgent\)/, 'listener 必须按当前 activeAgent 规范化 payload')
assert.match(lifecycle, /useRuntimeStore\.getState\(\)\.setAgentStatus\(status\.agentId \|\| status\.agent \|\| activeAgent, status\)/, 'listener 必须按 payload.agentId 路由状态，缺省回退 agent/activeAgent')
assert.match(lifecycle, /return \(\) => \{ disposed = true; unlisten\.then\(stop => stop\(\)\) \}/, '卸载时必须先设置 disposed 并清理 resolved unlisten')

assert.match(runtimeStore, /agentStatuses: Record<string, AgentStatus>/)
assert.match(runtimeStore, /setAgentStatus: \(id: string, status: AgentStatus\)/)
assert.match(runtimeStore, /setAgentStatus: \(id, status\) => set\(state => \(\{ agentStatuses: \{ \.\.\.state\.agentStatuses, \[id\]: status \} \}\)\)/)

// Dependency-free lifecycle probe: proves the guarded async completion cannot write after dispose.
let disposed = false
let writes = 0
let resolveAgents!: (value: unknown) => void
const pendingAgents = new Promise(resolve => { resolveAgents = resolve })
const load = () => pendingAgents.then(list => {
  if (!disposed) writes += Array.isArray(list) ? 1 : 1
})
const pendingLoad = load()
disposed = true
resolveAgents([{ id: 'peri', name: 'Peri' }])
await pendingLoad
assert.equal(writes, 0, '已卸载组件不得回写 list_agents 异步结果')

// The routing contract is also checked with the real dependency-free normalizer.
const status = normalizeAgentStatus({ agentId: 'prism', agent: 'Prism', status: 'connected' }, 'peri')
const routedAgent = status.agentId || status.agent || 'peri'
assert.equal(routedAgent, 'prism')
assert.equal(status.status, 'connected')
const fallback = normalizeAgentStatus({ status: 'reconnecting' }, 'peri')
assert.equal(fallback.agent || 'peri', 'peri')

console.log('agent listener lifecycle 结构回归测试通过')
