/**
 * chatContracts — ACP wire 类型与 extract 收边界（P1-09，归一化层归属 infrastructure/acp）。
 *
 * 从 components/chat/acpTypes 迁入（§5.2/§7 收拢）：wire 类型 + 宽容提取函数只在此处
 * 真实定义；components/chat/acpTypes 保留兼容 re-export。归一化只搬运不翻译。
 */

export interface ConfigOptionChoice {
  id?: string
  value?: string
  name?: string
  label?: string
}

export interface ConfigOption {
  id?: string
  key?: string
  name?: string
  type?: string
  currentValue?: unknown
  value?: unknown
  current?: unknown
  selected?: unknown
  options?: ConfigOptionChoice[]
  choices?: ConfigOptionChoice[]
  values?: ConfigOptionChoice[]
  available?: ConfigOptionChoice[]
}

export interface AvailableCommand {
  name: string
  input_hint?: string
  description?: string
}

export interface SessionModes {
  currentModeId?: unknown
  currentMode?: unknown
  current?: unknown
}

export interface SessionResponseObject {
  sessionId?: string
  periId?: string
  modes?: SessionModes
  configOptions?: ConfigOption[]
  usage?: { used?: number; value?: number; size?: number; tokensUsed?: number; tokensMax?: number; cacheReadTokens?: number }
  sessionInfo?: { usage?: SessionResponseObject['usage']; mode?: unknown; currentMode?: unknown }
}

export type SessionResponse = string | SessionResponseObject

interface UpdateBase extends OptionalChatEventIdentity {
  _meta?: {
    periReplay?: boolean
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
  }
}

// —— P1-03：plan / content 协议扩展（wire 层宽容类型；收窄在 domains/infrastructure）——

/** plan wire entry（原始形态，宽容；收窄到 domains/tasks 的 PlanEntry） */
export interface WirePlanEntry {
  content?: string
  priority?: number
  status?: string
}

/** 内容 chunk：ACP messageId 随 chunk 透传；其他 identity 字段仅兼容可选 envelope。 */
export interface ContentChunk {
  text?: string
  messageId?: string
  eventId?: string
  turnId?: string
}

/** 工具内容块：text/图片/diff 等；未知 content type 保留通用对象不抛错（D13） */
export interface ContentBlock {
  type?: string
  text?: string
  [key: string]: unknown
}

export type SessionUpdate =
  | (UpdateBase & { sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk'; content?: ContentChunk })
  | (UpdateBase & { sessionUpdate: 'tool_call'; toolCallId?: string; title?: string; kind?: string; content?: ContentBlock[]; rawInput?: unknown; locations?: unknown })
  | (UpdateBase & { sessionUpdate: 'tool_call_update'; toolCallId?: string; title?: string; kind?: string; content?: ContentBlock[]; rawOutput?: unknown; status?: string })
  | (UpdateBase & { sessionUpdate: 'usage_update'; used?: number; value?: number; size?: number })
  | (UpdateBase & { sessionUpdate: 'session_info_update'; mode?: unknown; currentMode?: unknown; usage?: { used?: number; value?: number; size?: number; tokensUsed?: number; tokensMax?: number; cacheReadTokens?: number }; sessionInfo?: SessionResponseObject['sessionInfo'] })
  | (UpdateBase & { sessionUpdate: 'available_commands_update'; commands?: AvailableCommand[] })
  | (UpdateBase & { sessionUpdate: 'config_option_update'; configOptions?: ConfigOption[]; id?: string; key?: string; currentValue?: unknown; value?: unknown })
  | (UpdateBase & { sessionUpdate: 'plan'; entries?: WirePlanEntry[] })

export interface PeriUpdatePayload {
  source: string
  update: SessionUpdate
  /** Rust Kernel 已写入 canonical_events 后附带的 committed flat row。 */
  canonicalEvent?: unknown
}

export interface PeriDonePayload {
  source: string
  replay?: boolean
  canonicalEvent?: unknown
}

/** 可选内部 envelope 身份；不改变 ACP wire 的必需字段。 */
export interface OptionalChatEventIdentity {
  messageId?: string
  eventId?: string
  turnId?: string
  toolCallId?: string
}

export function sessionResponseObject(response: unknown): SessionResponseObject {
  if (typeof response === 'string') return { sessionId: response }
  return (response ?? {}) as SessionResponseObject
}

export function extractModelConfig(configOptions: ConfigOption[] | undefined): { model?: string; models?: string[] } {
  if (!Array.isArray(configOptions)) return {}
  const option = configOptions.find(item => (item.id || item.key || item.name) === 'model')
  if (!option) return {}
  const current = option.currentValue ?? option.value ?? option.current ?? option.selected
  const rawChoices = option.options ?? option.choices ?? option.values ?? option.available
  const models = rawChoices
    ?.map(choice => choice.id ?? choice.value ?? choice.name)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  return {
    model: current == null ? undefined : String(current),
    models: models?.length ? models : undefined,
  }
}

export function extractMode(response: SessionResponseObject): string | undefined {
  const option = response.configOptions?.find(item => (item.id || item.key) === 'mode')
  const value = response.modes?.currentModeId
    ?? response.modes?.currentMode
    ?? response.modes?.current
    ?? option?.currentValue
    ?? option?.value
    ?? response.sessionInfo?.mode
    ?? response.sessionInfo?.currentMode
  return value == null ? undefined : String(value)
}

export function extractSessionUsage(response: SessionResponseObject): { tokensUsed: number; tokensMax: number; cacheReadTokens: number } | undefined {
  const usage = response.usage ?? response.sessionInfo?.usage
  if (!usage) return undefined
  return {
    tokensUsed: usage.tokensUsed ?? usage.used ?? usage.value ?? 0,
    tokensMax: usage.tokensMax ?? usage.size ?? 131072,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
  }
}

export function extractUsage(update: Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>) {
  return {
    tokensUsed: update.used ?? update.value ?? 0,
    tokensMax: update.size ?? 131072,
    cacheReadTokens: update._meta?.cacheReadTokens ?? 0,
  }
}

// —— P1-03：kind / content / plan entries 提取（多键兜底，新 agent 字段漂移扩展位）——

/** tool kind 提取：仅接受非空字符串（Peri/Hermes/第三方字段漂移时宽容返回 undefined） */
export function extractToolKind(update: unknown): string | undefined {
  if (typeof update !== 'object' || update === null) return undefined
  const value = (update as Record<string, unknown>).kind ?? (update as Record<string, unknown>).toolType
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** content 提取：非数组返回 undefined；未知 content type 保留通用对象不抛错 */
export function extractContentBlocks(update: unknown): ContentBlock[] | undefined {
  if (typeof update !== 'object' || update === null) return undefined
  const raw = (update as Record<string, unknown>).content
  if (!Array.isArray(raw)) return undefined
  const blocks: ContentBlock[] = []
  for (const item of raw) {
    if (typeof item === 'object' && item !== null) {
      blocks.push({ ...(item as Record<string, unknown>) } as ContentBlock)
    }
  }
  return blocks
}

/** plan entries 提取：非数组返回 undefined（空快照 [] 与缺失 undefined 区分） */
export function extractPlanEntries(update: unknown): WirePlanEntry[] | undefined {
  if (typeof update !== 'object' || update === null) return undefined
  const raw = (update as Record<string, unknown>).entries
  return Array.isArray(raw) ? raw as WirePlanEntry[] : undefined
}
