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
}

export type SessionResponse = string | SessionResponseObject

interface UpdateBase {
  _meta?: {
    periReplay?: boolean
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
  }
}

export type SessionUpdate =
  | (UpdateBase & { sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk'; content?: { text?: string } })
  | (UpdateBase & { sessionUpdate: 'tool_call'; toolCallId?: string; title?: string; rawInput?: unknown })
  | (UpdateBase & { sessionUpdate: 'tool_call_update'; toolCallId?: string; rawOutput?: unknown; status?: string })
  | (UpdateBase & { sessionUpdate: 'usage_update'; used?: number; value?: number; size?: number })
  | (UpdateBase & { sessionUpdate: 'available_commands_update'; commands?: AvailableCommand[] })
  | (UpdateBase & { sessionUpdate: 'config_option_update'; configOptions?: ConfigOption[]; id?: string; key?: string; currentValue?: unknown; value?: unknown })

export interface PeriUpdatePayload {
  source: string
  update: SessionUpdate
}

export interface PeriDonePayload {
  source: string
}

export function sessionResponseObject(response: SessionResponse): SessionResponseObject {
  return typeof response === 'string' ? { sessionId: response } : response
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
  return value == null ? undefined : String(value)
}

export function extractUsage(update: Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>) {
  return {
    tokensUsed: update.used ?? update.value ?? 0,
    tokensMax: update.size ?? 131072,
    cacheReadTokens: update._meta?.cacheReadTokens ?? 0,
  }
}
