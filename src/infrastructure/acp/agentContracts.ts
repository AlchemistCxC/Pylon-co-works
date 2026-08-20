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
 * - lifecycle status 是 connected 唯一真值；capabilities 缺失只表示能力未协商。
 */

export interface AgentCapabilitySnapshot {
  connected: boolean
  capabilitiesKnown: boolean
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

/** 能力快照派生：lifecycle 决定连接，capabilities 独立表达协商是否完成。 */
export function resolveCapabilitySnapshot(status: AgentStatus | null | undefined): AgentCapabilitySnapshot {
  const capabilities = status == null ? undefined : status.capabilities
  const connected = status?.status === 'connected'
  const capabilitiesKnown = isPlainObject(capabilities)
  const caps = isPlainObject(capabilities) ? capabilities : null
  const session = isPlainObject(caps?.sessionCapabilities) ? caps.sessionCapabilities : null
  const prompt = isPlainObject(caps?.promptCapabilities) ? caps.promptCapabilities : null
  const mcp = isPlainObject(caps?.mcpCapabilities) ? caps.mcpCapabilities : null
  const authMethods = caps?.authMethods
  return {
    connected,
    capabilitiesKnown,
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

// —— 附件入口能力降级（F4-C：promptImage 只控制图片 mime，同一入口降级而非两个按钮）——

const ATTACH_TEXT_EXTENSIONS = ['txt', 'md', 'log', 'json', 'yaml', 'yml', 'csv']

const ATTACH_FILTERS_TEXT: { name: string; extensions: string[] }[] = [
  { name: '文本', extensions: ATTACH_TEXT_EXTENSIONS },
]

const ATTACH_FILTERS_IMAGE_TEXT: { name: string; extensions: string[] }[] = [
  { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
  { name: '文本', extensions: ATTACH_TEXT_EXTENSIONS },
]

export type AttachGate = { allowed: true } | { allowed: false; reason: string }

/** 附件入口 gate（F4-B）：未连接/能力未到 → 拦截并给原因；已连接 → 放行 */
export function resolveAttachGate(snapshot: AgentCapabilitySnapshot): AttachGate {
  if (!snapshot.connected) return { allowed: false, reason: 'Agent 未连接，附件暂不可用' }
  return { allowed: true }
}

/** 附件选择器 filters：promptImage=true → 图片+文本；false → 仅文本（accept 降级） */
export function resolveAttachFilters(snapshot: AgentCapabilitySnapshot): { name: string; extensions: string[] }[] {
  return snapshot.promptImage ? ATTACH_FILTERS_IMAGE_TEXT : ATTACH_FILTERS_TEXT
}
