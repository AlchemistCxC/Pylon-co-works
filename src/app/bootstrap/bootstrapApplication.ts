/**
 * bootstrapApplication — 单一启动事务（报告阶段 2 / FE-AUD-005）。
 *
 * 顺序固定：迁移配置（store.ts persist rehydrate 已完成）→ hydrate domains →
 * 获取 agents → 应用 agents（F13 起为 prune，不重复全量 hydrate）→ 注册全局
 * listener → ready。Agent 列表失败属 degraded：不清空本地工作区，可重试。
 * 纯函数（node 可测）：不直接依赖 Tauri/React，传输与 store 经 deps 注入。
 */
import type { AgentEntry } from '../../identityStore'
import type { HydrationStatus } from './hydrationState'

export type BootstrapResult = 'ready' | 'degraded' | 'fatal' | 'cancelled'

export interface BootstrapDeps {
  isTauri: boolean
  /** 迁移配置 → hydrate domains（profiles/sessions/workspace）；应幂等 */
  hydrateDomains: () => void
  fetchAgents: () => Promise<AgentEntry[]>
  /** 应用 agents 结果（阶段 2 后为 prune 语义，不再全量替换 hydrate） */
  applyAgents: (agents: AgentEntry[]) => void
  /** 冷启动 Agent 状态快照（release-issues #1 方案 A）：list_agents 后查询一次
   * agent_status，补上 listener 注册前的初始状态缺失。可选——失败不降级，
   * 状态灯保持缺失态直到后续事件增量（纯函数便于测试）。 */
  fetchAgentStatus?: () => Promise<unknown>
  /** 应用初始状态快照：写入 runtimeStore.agentStatuses（与事件 listener 同构） */
  applyAgentStatus?: (payload: unknown) => void
  /** 注册全局 controller/listener，返回 dispose handle（阶段 2.8） */
  registerListeners: () => Promise<() => void>
  reportError: (action: string, error: unknown) => void
  setStatus: (status: HydrationStatus, error?: string | null) => void
  /** 组件卸载后为 true：不再应用迟到的 agents/listener 结果 */
  cancelled: () => boolean
}

export async function bootstrapApplication(deps: BootstrapDeps): Promise<BootstrapResult> {
  deps.setStatus('loading')
  try {
    deps.hydrateDomains()
  } catch (error) {
    deps.reportError('恢复本地数据', error)
    deps.setStatus('degraded', '本地数据恢复失败')
    return 'degraded'
  }

  if (!deps.isTauri) {
    deps.setStatus('ready')
    return 'ready'
  }

  let agents: AgentEntry[]
  try {
    agents = await deps.fetchAgents()
  } catch (error) {
    // degraded：本地工作区保留，可重试（报告阶段 2.4）
    deps.reportError('读取 Agent 列表', error)
    deps.setStatus('degraded', '读取 Agent 列表失败')
    return 'degraded'
  }
  if (deps.cancelled()) return 'cancelled'
  deps.applyAgents(agents)

  // 冷启动状态快照（方案 A）：list_agents 之后、listener 注册之前查询一次初始状态。
  // 失败不降级——缺失状态只影响启动首帧的状态灯，后续事件增量会补齐。
  if (deps.fetchAgentStatus && deps.applyAgentStatus) {
    try {
      const payload = await deps.fetchAgentStatus()
      if (deps.cancelled()) return 'cancelled'
      deps.applyAgentStatus(payload)
    } catch (error) {
      deps.reportError('读取 Agent 状态', error)
    }
  }

  let dispose: () => void
  try {
    dispose = await deps.registerListeners()
  } catch (error) {
    deps.reportError('注册事件监听', error)
    deps.setStatus('degraded', '注册事件监听失败')
    return 'degraded'
  }
  if (deps.cancelled()) {
    dispose()
    return 'cancelled'
  }
  deps.setStatus('ready')
  return 'ready'
}
