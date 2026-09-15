import type { AgentStatus } from '../../components/settings/agentTypes'

/**
 * agentContracts — 能力快照归一化层（P2-02 / #98 协商快照三层投影）。
 *
 * infrastructure 收边界：agent-status 链路携带两种能力数据：
 * - `capabilitySnapshot`：后端能力矩阵（Rust `acp/negotiated.rs`）产出的结构化
 *   三层快照（advertised/negotiated/usable + fact/source/diagnostics）——权威
 *   来源。组件只消费 usable；usable=false 的能力（含「已广告但未注册消费者」
 *   的 fork/elicitation）不得对外表现为可点击。
 * - `capabilities`：initialize agentCapabilities 原始 Value——诊断保留，不再
 *   由前端逐键解释。
 *
 * 无结构化快照时（旧载荷/demo/非法形状）按矩阵同语义做 raw 兜底推导，缺失
 * 一律 fail-closed：未知/缺省能力不再默认 true（旧 sessionClose/mcp 缺省 true
 * 的 fail-open 兼容默认废除，迁移决策见 ADR-0004）。canonical 路径为
 * `sessionCapabilities.<id>`；根级 `loadSession: true` 是唯一登记的兼容 alias
 * （canonical 缺失时生效）。
 *
 * lifecycle status 是 connected 唯一真值；capabilities 缺失只表示能力未协商。
 */

/** 后端能力矩阵单条能力的投影（与 Rust `CapabilityDecision::wire_value` 同构）。 */
export interface CapabilityLayerState {
  fact?: 'unknown' | 'advertised' | 'negotiated' | 'usable'
  source?: 'canonical' | 'root-alias' | 'host' | 'none'
  advertised?: boolean | null
  negotiated?: boolean
  usable?: boolean
  diagnostics?: string[]
}

/** agent_status.capabilitySnapshot 的形状（与 Rust `NegotiatedCapabilitySnapshot::wire_value` 同构）。 */
export interface CapabilitySnapshotPayload {
  generation?: number
  capabilities?: Record<string, CapabilityLayerState>
}

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

/** 结构化快照 usable 投影：只有显式 usable=true 才算可用（fail-closed）。 */
const usableFromSnapshot = (
  snapshot: CapabilitySnapshotPayload,
  id: string,
): boolean => isPlainObject(snapshot.capabilities) && snapshot.capabilities[id]?.usable === true

/** raw 兜底：canonical object capability（object 值才算广告，与 Rust 矩阵一致）。 */
const rawObjectCapability = (session: Record<string, unknown> | null, id: string): boolean =>
  isPlainObject(session?.[id])

/** 能力快照派生：lifecycle 决定连接，结构化协商快照优先，raw 兜底 fail-closed。 */
export function resolveCapabilitySnapshot(status: AgentStatus | null | undefined): AgentCapabilitySnapshot {
  const capabilities = status == null ? undefined : status.capabilities
  const connected = status?.status === 'connected'
  const capabilitiesKnown = isPlainObject(capabilities)
  const caps = isPlainObject(capabilities) ? capabilities : null
  const sessionCaps = caps?.sessionCapabilities
  const promptCaps = caps?.promptCapabilities
  const mcpCaps = caps?.mcpCapabilities
  const session = isPlainObject(sessionCaps) ? sessionCaps : null
  const prompt = isPlainObject(promptCaps) ? promptCaps : null
  const mcp = isPlainObject(mcpCaps) ? mcpCaps : null
  const authMethods = caps?.authMethods
  const snapshotPayload = isPlainObject(status?.capabilitySnapshot)
    ? (status.capabilitySnapshot as CapabilitySnapshotPayload)
    : null
  if (snapshotPayload) {
    // 权威路径：后端矩阵三层快照（与 session 建立/重连探针同一份协商结论）。
    return {
      connected,
      capabilitiesKnown,
      loadSession: usableFromSnapshot(snapshotPayload, 'load'),
      promptImage: usableFromSnapshot(snapshotPayload, 'promptImage'),
      sessionFork: usableFromSnapshot(snapshotPayload, 'fork'),
      sessionResume: usableFromSnapshot(snapshotPayload, 'resume'),
      sessionClose: usableFromSnapshot(snapshotPayload, 'close'),
      sessionList: usableFromSnapshot(snapshotPayload, 'list'),
      mcpHttp: usableFromSnapshot(snapshotPayload, 'mcpHttp'),
      mcpSse: usableFromSnapshot(snapshotPayload, 'mcpSse'),
      hasAuthMethods: Array.isArray(authMethods) && authMethods.length > 0,
    }
  }
  return {
    connected,
    capabilitiesKnown,
    // canonical 缺失时根级布尔 alias 兼容生效（唯一登记的 alias）。已知角落：
    // canonical 为错误类型（如 boolean）且根级 alias 为 true 时，本兜底投影
    // true 而 Rust 矩阵判类型错误 fail-closed——仅影响无结构化快照的旧载荷，
    // 以结构化快照为准。
    loadSession: rawObjectCapability(session, 'loadSession') || caps?.loadSession === true,
    promptImage: prompt?.image === true,
    // raw 无消费者登记信息：fork 恒 fail-closed（ghost capability 防线）。
    sessionFork: false,
    sessionResume: rawObjectCapability(session, 'resume'),
    sessionClose: session?.close === true,
    sessionList: session?.list === true,
    mcpHttp: mcp?.http === true,
    mcpSse: mcp?.sse === true,
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
