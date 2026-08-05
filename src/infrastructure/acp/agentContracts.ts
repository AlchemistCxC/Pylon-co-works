import type { AgentStatus } from '../../components/settings/agentTypes'

/**
 * agentContracts — 能力快照归一化层（P2-02，F4-A/F4-D）。
 *
 * infrastructure 收边界：把 agent-status 链路携带的 capabilities 原始 Value（Peri/Hermes
 * 形状不同且会漂移）收窄为组件可消费的稳定 boolean 快照。组件不读原始 capabilities，
 * 只读快照；纯函数，零 React 依赖，可被 scripts 直接 import。
 *
 * 语义判据（写死，测试守卫）：
 * - 快照键一律「能力存在 = true」命名，读取宽容（?. + 缺省）。
 * - 例外① sessionClose 缺省 true（Peri 有、Hermes 显式无、未来 agent 未声明按 ACP 基线有）。
 * - 例外② mcpHttp/mcpSse 缺省 true，显式 false 才关闭（未声明 ≠ 不支持）。
 * - null/缺失 capabilities = 未连接，connected:false，其余键取保守缺省。
 */

export interface AgentCapabilitySnapshot {
  connected: boolean
  loadSession: boolean
  promptImage: boolean
  sessionFork: boolean
  sessionResume: boolean
  sessionClose: boolean
  sessionList: boolean
  mcpHttp: boolean
  mcpSse: boolean
  hasAuthMethods: boolean
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 能力快照派生：null/缺失 capabilities → connected:false + 保守缺省；空对象不断线 */
export function resolveCapabilitySnapshot(status: AgentStatus | null | undefined): AgentCapabilitySnapshot {
  const capabilities = status == null ? undefined : status.capabilities
  const connected = capabilities !== null && capabilities !== undefined
  const caps = isPlainObject(capabilities) ? capabilities : null
  const session = isPlainObject(caps?.sessionCapabilities) ? caps.sessionCapabilities : null
  const prompt = isPlainObject(caps?.promptCapabilities) ? caps.promptCapabilities : null
  const mcp = isPlainObject(caps?.mcpCapabilities) ? caps.mcpCapabilities : null
  const authMethods = caps?.authMethods
  return {
    connected,
    loadSession: caps?.loadSession === true,
    promptImage: prompt?.image === true,
    sessionFork: session?.fork === true,
    sessionResume: session?.resume === true,
    sessionClose: session?.close !== false,
    sessionList: session?.list === true,
    mcpHttp: mcp?.http !== false,
    mcpSse: mcp?.sse !== false,
    hasAuthMethods: Array.isArray(authMethods) && authMethods.length > 0,
  }
}
