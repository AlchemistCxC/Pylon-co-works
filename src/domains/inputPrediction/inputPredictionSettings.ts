import type { InputPredictionProvider, InputPredictionRequest } from '../../renderers/solid-workbench/input/inputPredictionProvider.ts'
import { boundPredictionHistory, boundPredictionMessages } from '../../renderers/solid-workbench/input/inputPredictionProvider.ts'

export const INPUT_PREDICTION_SETTINGS_KEY = 'pylon-input-prediction-settings-v1'

export type PredictionReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'
export type InputPredictionMode = 'auto' | 'fork' | 'standalone' | 'off'

export interface InputPredictionSettings {
  mode: InputPredictionMode
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
  endpointPath: string
  reasoningEffort: PredictionReasoningEffort
  temperature: number
  topP: number
  maxTokens: number
  frequencyPenalty: number
  presencePenalty: number
  seed: number | null
  stop: string
  systemPrompt: string
  includeHistory: boolean
  maxHistoryItems: number
  maxHistoryChars: number
  timeoutMs: number
  headersJson: string
}

export const DEFAULT_INPUT_PREDICTION_SETTINGS: Readonly<InputPredictionSettings> = Object.freeze({
  mode: 'auto', enabled: false, baseUrl: '', apiKey: '', model: '', endpointPath: '/chat/completions',
  reasoningEffort: 'medium', temperature: 0.2, topP: 1, maxTokens: 64,
  frequencyPenalty: 0, presencePenalty: 0, seed: null, stop: '',
  systemPrompt: 'Predict the next short message the user is likely to type. Reply with only the message, or an empty string.',
  includeHistory: true, maxHistoryItems: 24, maxHistoryChars: 6000, timeoutMs: 8000, headersJson: '{}',
})

function numberOr(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

export function normalizeInputPredictionSettings(value: unknown): InputPredictionSettings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const effort = raw.reasoningEffort
  return {
    mode: raw.mode === 'auto' || raw.mode === 'fork' || raw.mode === 'standalone' || raw.mode === 'off' ? raw.mode : DEFAULT_INPUT_PREDICTION_SETTINGS.mode,
    enabled: raw.enabled === true,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    model: typeof raw.model === 'string' ? raw.model.trim() : '',
    endpointPath: typeof raw.endpointPath === 'string' && raw.endpointPath.trim() ? raw.endpointPath.trim() : DEFAULT_INPUT_PREDICTION_SETTINGS.endpointPath,
    reasoningEffort: effort === 'none' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' ? effort : DEFAULT_INPUT_PREDICTION_SETTINGS.reasoningEffort,
    temperature: numberOr(raw.temperature, DEFAULT_INPUT_PREDICTION_SETTINGS.temperature, 0, 2),
    topP: numberOr(raw.topP, DEFAULT_INPUT_PREDICTION_SETTINGS.topP, 0, 1),
    maxTokens: Math.round(numberOr(raw.maxTokens, DEFAULT_INPUT_PREDICTION_SETTINGS.maxTokens, 1, 4096)),
    frequencyPenalty: numberOr(raw.frequencyPenalty, 0, -2, 2), presencePenalty: numberOr(raw.presencePenalty, 0, -2, 2),
    seed: raw.seed === null || raw.seed === undefined ? null : Math.round(numberOr(raw.seed, 0, -2_147_483_648, 2_147_483_647)),
    stop: typeof raw.stop === 'string' ? raw.stop : '',
    systemPrompt: typeof raw.systemPrompt === 'string' && raw.systemPrompt.trim() ? raw.systemPrompt : DEFAULT_INPUT_PREDICTION_SETTINGS.systemPrompt,
    includeHistory: raw.includeHistory !== false,
    maxHistoryItems: Math.round(numberOr(raw.maxHistoryItems, 24, 1, 100)), maxHistoryChars: Math.round(numberOr(raw.maxHistoryChars, 6000, 100, 20000)),
    timeoutMs: Math.round(numberOr(raw.timeoutMs, 8000, 1000, 60000)), headersJson: typeof raw.headersJson === 'string' ? raw.headersJson : '{}',
  }
}

export function loadInputPredictionSettings(storage: Pick<Storage, 'getItem'> = globalThis.localStorage): InputPredictionSettings {
  try { return normalizeInputPredictionSettings(JSON.parse(storage.getItem(INPUT_PREDICTION_SETTINGS_KEY) ?? '{}')) } catch { return { ...DEFAULT_INPUT_PREDICTION_SETTINGS } }
}

export function saveInputPredictionSettings(settings: InputPredictionSettings, storage: Pick<Storage, 'setItem'> = globalThis.localStorage): void {
  storage.setItem(INPUT_PREDICTION_SETTINGS_KEY, JSON.stringify(normalizeInputPredictionSettings(settings)))
}

function parseHeaders(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, item]) => typeof item === 'string')) as Record<string, string>
  } catch { return {} }
}

function endpointFor(settings: InputPredictionSettings): string {
  return `${settings.baseUrl.replace(/\/$/, '')}/${settings.endpointPath.replace(/^\//, '')}`
}

export function createStandalonePredictionProvider(options: { fetch?: typeof globalThis.fetch; settings?: () => InputPredictionSettings } = {}): InputPredictionProvider {
  const request = options.fetch ?? globalThis.fetch
  return { async predict(input: InputPredictionRequest): Promise<string | null> {
    const settings = options.settings?.() ?? loadInputPredictionSettings()
    if (!settings.enabled || !settings.baseUrl || !settings.apiKey || !settings.model || input.signal.aborted) return null
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    input.signal.addEventListener('abort', onAbort, { once: true })
    const timer = globalThis.setTimeout(() => controller.abort(), settings.timeoutMs)
    try {
      const transcript = settings.includeHistory
        ? (input.messages?.length ? boundPredictionMessages(input.messages, settings) : boundPredictionHistory(input.history, settings).map(content => ({ role: 'user' as const, content })))
        : []
      const messages = [{ role: 'system', content: settings.systemPrompt }, ...transcript, { role: 'user', content: input.draft || '(empty draft)' }]
      const body: Record<string, unknown> = { model: settings.model, messages, temperature: settings.temperature, top_p: settings.topP, max_tokens: settings.maxTokens, frequency_penalty: settings.frequencyPenalty, presence_penalty: settings.presencePenalty }
      if (settings.reasoningEffort !== 'none') body.reasoning_effort = settings.reasoningEffort
      if (settings.seed !== null) body.seed = settings.seed
      if (settings.stop.trim()) body.stop = settings.stop.split(',').map(item => item.trim()).filter(Boolean)
      const response = await request(endpointFor(settings), { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}`, ...parseHeaders(settings.headersJson) }, body: JSON.stringify(body), signal: controller.signal })
      if (!response.ok) return null
      const payload = await response.json() as Record<string, unknown>
      const choices = Array.isArray(payload.choices) ? payload.choices[0] as Record<string, unknown> | undefined : undefined
      const message = choices?.message as Record<string, unknown> | undefined
      const content = message?.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) return content.filter(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string').map(item => (item as Record<string, unknown>).text as string).join('') || null
      return typeof choices?.text === 'string' ? choices.text : typeof payload.output_text === 'string' ? payload.output_text : null
    } finally { globalThis.clearTimeout(timer); input.signal.removeEventListener('abort', onAbort) }
  } }
}

/** Backwards-compatible name used by older hosts. */
export const createStoredInputPredictionProvider = createStandalonePredictionProvider

export interface PredictionRouterOptions {
  readonly forkProvider?: InputPredictionProvider
  readonly standaloneProvider?: InputPredictionProvider
  readonly settings?: () => InputPredictionSettings
}

/** Selects ACP fork or independent provider without issuing duplicate fallback requests. */
export function createPredictionRouter(options: PredictionRouterOptions = {}): InputPredictionProvider {
  const standalone = options.standaloneProvider ?? createStandalonePredictionProvider({ settings: options.settings })
  return {
    async predict(input: InputPredictionRequest): Promise<string | null> {
      const mode = options.settings?.().mode ?? loadInputPredictionSettings().mode
      if (mode === 'off') return null
      if (mode === 'fork') return options.forkProvider ? options.forkProvider.predict(input) : null
      if (mode === 'standalone') return standalone.predict(input)
      if (options.forkProvider) return options.forkProvider.predict(input)
      return standalone.predict(input)
    },
  }
}
