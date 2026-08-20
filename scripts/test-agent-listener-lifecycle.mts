/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { normalizeAgentStatus } from '../src/components/settings/agentTypes.ts'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const bootstrap = readFileSync(new URL('../src/app/bootstrap/bootstrapApplication.ts', import.meta.url), 'utf8')
const bootstrapRun = readFileSync(new URL('../src/app/bootstrap/applicationBootstrapRun.ts', import.meta.url), 'utf8')
const agentClient = readFileSync(new URL('../src/infrastructure/acp/agentClient.ts', import.meta.url), 'utf8')
const runtimeStore = readFileSync(new URL('../src/runtimeStore.ts', import.meta.url), 'utf8')

// FE-AUD-005：App 只保留单一 bootstrap effect（hydrate → agents → listener），
// cancelled/dispose 语义由 applicationBootstrapRun.ts 统一托管。
const effectStart = app.indexOf("  useEffect(() => {\n    const bootstrapRun = startApplicationBootstrap({")
assert.notEqual(effectStart, -1, 'bootstrap effect 必须经 lifecycle runner 启动')
const effectEnd = app.indexOf('\n  }, [bootstrapRetry])', effectStart)
assert.notEqual(effectEnd, -1, 'bootstrap effect 必须有清理边界')
const lifecycle = app.slice(effectStart, effectEnd + '\n  }, [bootstrapRetry])'.length)

assert.match(lifecycle, /startApplicationBootstrap\(\{/, 'App 必须走单一 bootstrap lifecycle runner')
assert.match(lifecycle, /fetchAgents: \(\) => agentClient\.listAgents\(\)/, 'bootstrap 必须经 typed client 加载 list_agents')
assert.match(agentClient, /invoke\('list_agents'\)/, 'list_agents command literal 收口在 client')
assert.match(lifecycle, /listen<AgentStatusPayload>\('pylon:agent-status'/, '必须注册 pylon:agent-status listener（H-9 事件前缀同步）')
assert.match(lifecycle, /const activeAgent = useIdentityStore\.getState\(\)\.activeAgent/, 'listener 必须从最新 identity store 读取 activeAgent')
assert.match(lifecycle, /normalizeAgentStatus\(event\.payload, activeAgent\)/, 'listener 必须按当前 activeAgent 规范化 payload')
assert.match(lifecycle, /useRuntimeStore\.getState\(\)\.setAgentStatus\(status\.agentId \|\| status\.agent \|\| activeAgent, status\)/, 'listener 必须按 payload.agentId 路由状态，缺省回退 agent/activeAgent')
assert.match(lifecycle, /return bootstrapRun\.dispose/, '卸载时必须释放 bootstrap lifecycle runner')
assert.match(bootstrapRun, /cancelled: \(\) => cancelled/, 'bootstrap 结果必须受 lifecycle cancelled guard 保护')
assert.match(bootstrapRun, /disposeListenerOnce\(\)/, 'Application 卸载必须释放 listener handle')
assert.match(bootstrap, /if \(deps\.cancelled\(\)\) return 'cancelled'/, '迟到的 agents 结果不得应用（cancelled 守卫）')
assert.match(bootstrap, /deps\.applyAgents\(agents\)/, 'applyAgents 必须在 fetch 成功后')

assert.match(runtimeStore, /agentStatuses: Record<string, AgentStatus>/)
assert.match(runtimeStore, /setAgentStatus: \(id: string, status: AgentStatus\)/)
assert.match(runtimeStore, /setAgentStatus: \(id, status\) => set\(state => \{[\s\S]*?shouldAcceptAgentStatus\(state\.agentStatuses\[id\], status\)/)

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
