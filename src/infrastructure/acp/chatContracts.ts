/**
 * chatContracts — ACP wire 类型与 extract 收边界（P1-09，归一化层归属 infrastructure/acp）。
 *
 * 从 components/chat/acpTypes 迁入（§5.2/§7 收拢）：wire 类型 + 宽容提取函数只在此处
 * 真实定义；components/chat/acpTypes 保留兼容 re-export。归一化只搬运不翻译。
 */

export interface ConfigOptionChoice {
  id?: string
  value?: string
  valueId?: string | { value?: string; valueId?: string; id?: string; key?: string }
  value_id?: string | { value?: string; valueId?: string; id?: string; key?: string }
  modelId?: string
  model_id?: string
  modeId?: string
  mode_id?: string
  name?: string
  label?: string
  title?: string
  displayName?: string
  [key: string]: unknown
}

export interface ConfigOption {
  id?: string
  key?: string
  configId?: string
  config_id?: string
  optionId?: string
  option_id?: string
  name?: string
  label?: string
  title?: string
  description?: string
  category?: string
  type?: string
  valueType?: string
  value_type?: string
  currentValue?: unknown
  current_value?: unknown
  value?: unknown
  current?: unknown
  selected?: unknown
  selectedValue?: unknown
  selected_value?: unknown
  defaultValue?: unknown
  default_value?: unknown
  options?: ConfigOptionChoice[]
  choices?: ConfigOptionChoice[]
  values?: ConfigOptionChoice[]
  available?: ConfigOptionChoice[]
  items?: ConfigOptionChoice[]
  schema?: unknown
  editable?: boolean
  readOnly?: boolean
  readonly?: boolean
  read_only?: boolean
  [key: string]: unknown
}

export interface AvailableCommand {
  name: string
  input_hint?: string
  description?: string
}

export interface SessionModes {
  currentModeId?: unknown
  current_mode_id?: unknown
  currentMode?: unknown
  current_mode?: unknown
  current?: unknown
  availableModes?: unknown
  available_modes?: unknown
  modes?: unknown
}

export interface SessionModels {
  currentModelId?: unknown
  current_model_id?: unknown
  currentModel?: unknown
  current_model?: unknown
  current?: unknown
  availableModels?: unknown
  available_models?: unknown
  models?: unknown
}

export interface SessionResponseObject {
  sessionId?: string
  session_id?: string
  periId?: string
  modes?: SessionModes
  models?: SessionModels
  configOptions?: ConfigOption[]
  config_options?: ConfigOption[]
  modelId?: unknown
  model_id?: unknown
  modeId?: unknown
  mode_id?: unknown
  availableModels?: unknown
  available_models?: unknown
  availableModes?: unknown
  available_modes?: unknown
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

/** Additive prompt failure provenance.  The legacy `error` string remains the
 * compatibility display field; renderers may use this metadata for a precise
 * diagnostic without guessing from provider prose. */
export type PromptFailureSource =
  | 'provider'
  | 'rpc'
  | 'prompt-timeout'
  | 'write-timeout'
  | 'connection'
  | 'cancelled'
  | 'internal'

export type PromptTimeoutKind = 'first-token' | 'idle' | 'rpc' | 'write'

export interface PromptFailureMetadata {
  readonly source: PromptFailureSource
  readonly timeoutKind?: PromptTimeoutKind
  readonly configuredTimeoutSecs?: number
  readonly triggeredTimeoutSecs?: number
  readonly actualElapsedMs?: number
  readonly providerMessage?: string
}

export interface PeriErrorPayload {
  source: string
  error: string
  cancelled?: boolean
  replay?: boolean
  canonicalEvent?: unknown
  failure?: PromptFailureMetadata
}

/** 可选内部 envelope 身份；不改变 ACP wire 的必需字段。 */
export interface OptionalChatEventIdentity {
  messageId?: string
  eventId?: string
  turnId?: string
  toolCallId?: string
}

type WireRecord = Record<string, unknown>

/** Return an object record without trusting provider-specific wire types. */
function asWireRecord(value: unknown): WireRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as WireRecord
    : undefined
}

function normalizedWireKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase()
}

/** Read a field using camelCase, snake_case, kebab-case and case variants. */
function readWireField(record: WireRecord | undefined, keys: readonly string[]): unknown {
  if (!record) return undefined
  const wanted = new Set(keys.map(normalizedWireKey))
  for (const [key, value] of Object.entries(record)) {
    if (wanted.has(normalizedWireKey(key))) return value
  }
  return undefined
}

const DEFAULT_VALUE_KEYS = [
  'valueId', 'value_id', 'modelId', 'model_id', 'modeId', 'mode_id',
  'id', 'key', 'value', 'currentValue', 'current_value', 'current',
  'selected', 'selectedValue', 'selected_value', 'name', 'label',
] as const

/**
 * Extract a machine-facing string from ACP scalar/nested value shapes.
 * Display labels are deliberately last; stable ids always win when both are
 * advertised (for example `{modelId, name}`).
 */
export function extractWireString(
  value: unknown,
  preferredKeys: readonly string[] = DEFAULT_VALUE_KEYS,
  depth = 0,
): string | undefined {
  if (depth > 8) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || undefined
  }
  const record = asWireRecord(value)
  if (!record) return undefined
  const visited = new Set<string>()
  for (const key of [...preferredKeys, ...DEFAULT_VALUE_KEYS]) {
    const normalized = normalizedWireKey(key)
    if (visited.has(normalized)) continue
    visited.add(normalized)
    const nested = readWireField(record, [key])
    if (nested === undefined || nested === value) continue
    const result = extractWireString(nested, preferredKeys, depth + 1)
    if (result) return result
  }
  return undefined
}

/** Return the provider's config option id, including ACP v1.4 aliases. */
export function extractConfigOptionId(option: unknown): string | undefined {
  const record = asWireRecord(option)
  return extractWireString(record, [
    'configId', 'config_id', 'optionId', 'option_id', 'id', 'key', 'name',
  ])
}

/** Return the selected config value, unwrapping value/valueId envelopes. */
export function extractConfigOptionValue(option: unknown): unknown {
  const record = asWireRecord(option)
  if (!record) return undefined
  const keys = [
    'currentValue', 'current_value', 'selectedValue', 'selected_value',
    'selected', 'value', 'current', 'defaultValue', 'default_value',
  ] as const
  for (const key of keys) {
    const raw = readWireField(record, [key])
    if (raw === undefined) continue
    return unwrapWireValue(raw)
  }
  return undefined
}

function unwrapWireValue(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as WireRecord
  for (const key of ['valueId', 'value_id', 'modelId', 'model_id', 'modeId', 'mode_id', 'id', 'key', 'value']) {
    const nested = readWireField(record, [key])
    if (nested !== undefined && nested !== value) return unwrapWireValue(nested, depth + 1)
  }
  return value
}

/** Return all advertised choices from options/choices/schema/enum variants. */
export function extractConfigOptionChoices(option: unknown): readonly unknown[] {
  const record = asWireRecord(option)
  if (!record) return []
  const found: unknown[] = []
  const seen = new Set<unknown>()
  const collect = (value: unknown, depth: number): void => {
    if (depth > 5 || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      found.push(...value)
      return
    }
    const nested = asWireRecord(value)
    if (!nested) return
    for (const key of ['options', 'choices', 'values', 'available', 'items', 'enum', 'schema']) {
      const child = readWireField(nested, [key])
      if (child !== undefined) collect(child, depth + 1)
    }
  }
  for (const key of ['options', 'choices', 'values', 'available', 'items', 'schema']) {
    const value = readWireField(record, [key])
    if (value !== undefined) collect(value, 0)
  }
  return found
}

/** Extract a choice's machine id; modelId/modeId precede display names. */
export function extractChoiceId(value: unknown, kind?: 'model' | 'mode'): string | undefined {
  const preferred = kind === 'model'
    ? ['modelId', 'model_id', 'id', 'valueId', 'value_id', 'key', 'value', 'name', 'label']
    : kind === 'mode'
      ? ['modeId', 'mode_id', 'id', 'valueId', 'value_id', 'key', 'value', 'name', 'label']
      : DEFAULT_VALUE_KEYS
  return extractWireString(value, preferred)
}

/** Presentation label helper that never changes the machine id sent on wire. */
export function extractChoiceLabel(value: unknown, fallback?: string): string | undefined {
  const record = asWireRecord(value)
  for (const key of ['label', 'title', 'displayName', 'display_name', 'name', 'description']) {
    const candidate = extractWireString(readWireField(record, [key]), [])
    if (candidate) return candidate
  }
  return fallback ?? extractChoiceId(value)
}

export type ConfigOptionSemantic = 'model' | 'mode' | 'reasoning'

function semanticTokens(option: unknown): string[] {
  const record = asWireRecord(option)
  if (!record) return []
  const values = ['configId', 'config_id', 'optionId', 'option_id', 'id', 'key', 'name', 'label', 'title', 'category', 'description']
    .map(key => extractWireString(readWireField(record, [key]), []))
    .filter((value): value is string => Boolean(value))
  return values.map(value => normalizedWireKey(value).replace(/_/g, ''))
}

/** Find an option by semantic id while tolerating provider naming drift. */
export function findConfigOption(
  options: readonly unknown[] | undefined,
  semantic: ConfigOptionSemantic,
): unknown | undefined {
  if (!Array.isArray(options)) return undefined
  const aliases = semantic === 'model'
    ? ['model', 'models', 'modelid', 'modelselection']
    : semantic === 'mode'
      ? ['mode', 'modes', 'modeid', 'permissionsmode', 'permissionmode']
      : ['reason', 'reasoning', 'reasoningeffort', 'thinking', 'thought', 'thoughtlevel', 'effort']
  const ranked = options.map((option, index) => {
    const tokens = semanticTokens(option)
    let score = 0
    for (const token of tokens) {
      if (aliases.includes(token)) score = Math.max(score, 100)
      else if (aliases.some(alias => token.includes(alias))) score = Math.max(score, 60)
    }
    return { option, index, score }
  }).filter(item => item.score > 0)
  ranked.sort((left, right) => right.score - left.score || left.index - right.index)
  return ranked[0]?.option
}

function responseSection(response: SessionResponseObject | undefined, section: 'models' | 'modes'): WireRecord | undefined {
  const root = asWireRecord(response)
  const nested = readWireField(root, [section])
  return asWireRecord(nested)
}

function responseConfigOptions(response: SessionResponseObject | undefined): readonly unknown[] {
  const root = asWireRecord(response)
  const options = readWireField(root, ['configOptions', 'config_options'])
  return Array.isArray(options) ? options : []
}

function responseChoices(response: SessionResponseObject | undefined, kind: 'model' | 'mode'): readonly unknown[] {
  const root = asWireRecord(response)
  const section = responseSection(response, kind === 'model' ? 'models' : 'modes')
  const keys = kind === 'model'
    ? ['availableModels', 'available_models', 'models', 'options', 'choices']
    : ['availableModes', 'available_modes', 'modes', 'options', 'choices']
  const nested = readWireField(section, keys)
  if (Array.isArray(nested)) return nested
  const topLevel = readWireField(root, kind === 'model'
    ? ['availableModels', 'available_models']
    : ['availableModes', 'available_modes'])
  return Array.isArray(topLevel) ? topLevel : []
}

function responseCurrent(response: SessionResponseObject | undefined, kind: 'model' | 'mode'): string | undefined {
  const section = responseSection(response, kind === 'model' ? 'models' : 'modes')
  const keys = kind === 'model'
    ? ['currentModelId', 'current_model_id', 'currentModel', 'current_model', 'current', 'modelId', 'model_id']
    : ['currentModeId', 'current_mode_id', 'currentMode', 'current_mode', 'current', 'modeId', 'mode_id']
  return extractWireString(readWireField(section, keys), keys)
    ?? extractWireString(readWireField(asWireRecord(response), keys), keys)
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

export function sessionResponseObject(response: unknown): SessionResponseObject {
  if (typeof response === 'string') return { sessionId: response }
  return asWireRecord(response) as SessionResponseObject ?? {}
}

export function extractModelConfig(
  configOptions: ConfigOption[] | undefined,
  response?: SessionResponseObject,
): { model?: string; models?: string[] } {
  const options = Array.isArray(configOptions) ? configOptions : responseConfigOptions(response)
  const option = findConfigOption(options, 'model')
  const current = extractWireString(extractConfigOptionValue(option), ['valueId', 'value_id', 'modelId', 'model_id', 'id', 'key', 'value'])
    ?? responseCurrent(response, 'model')
  const optionModels = extractConfigOptionChoices(option).map(choice => extractChoiceId(choice, 'model'))
  const responseModels = responseChoices(response, 'model').map(choice => extractChoiceId(choice, 'model'))
  const models = uniqueStrings([...optionModels, ...responseModels])
  return {
    ...(current ? { model: current } : {}),
    ...(models.length > 0 ? { models } : {}),
  }
}

/** Extract ACP mode ids while preserving the provider's raw ids for writes. */
export function extractModeConfig(response: SessionResponseObject): { mode?: string; modes?: string[] } {
  const options = responseConfigOptions(response)
  const option = findConfigOption(options, 'mode')
  const current = responseCurrent(response, 'mode')
    ?? extractWireString(extractConfigOptionValue(option), ['valueId', 'value_id', 'modeId', 'mode_id', 'id', 'key', 'value'])
    ?? extractWireString(readWireField(asWireRecord(response), ['mode', 'mode_id', 'modeId']), ['valueId', 'value_id', 'modeId', 'mode_id', 'id', 'key', 'value'])
  const modes = uniqueStrings(responseChoices(response, 'mode').map(choice => extractChoiceId(choice, 'mode')))
  return {
    ...(current ? { mode: current } : {}),
    ...(modes.length > 0 ? { modes } : {}),
  }
}

/** Extract the currently selected reasoning/thinking effort and its choices. */
export function extractReasoningConfig(
  configOptions: ConfigOption[] | undefined,
  response?: SessionResponseObject,
): { thinkingEffort?: string; reasoning?: string[] } {
  const options = Array.isArray(configOptions) ? configOptions : responseConfigOptions(response)
  const option = findConfigOption(options, 'reasoning')
  if (!option) return {}
  const current = extractWireString(extractConfigOptionValue(option), [
    'valueId', 'value_id', 'reasoning', 'thinkingEffort', 'thinking_effort', 'effort', 'id', 'key', 'value',
  ])
  const choices = uniqueStrings(extractConfigOptionChoices(option).map(choice => extractChoiceId(choice)))
  return {
    ...(current ? { thinkingEffort: current } : {}),
    ...(choices.length > 0 ? { reasoning: choices } : {}),
  }
}

export function extractMode(response: SessionResponseObject): string | undefined {
  return extractModeConfig(response).mode
    ?? extractWireString(readWireField(asWireRecord(response.sessionInfo), ['mode', 'currentMode', 'current_mode']), ['valueId', 'value_id', 'modeId', 'mode_id', 'id', 'key', 'value'])
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
