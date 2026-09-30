/**
 * predictionStandalone — 独立（OpenAI 兼容）HTTP 预测 provider 工厂（自 domains 迁入）。
 *
 * fetch/provider 路由属基础设施关注（结构审查 B-6）；域内只留 settings 纯函数与
 * 策略。settings 的读取经 options.settings 注入或缺省走域内同步缓存
 * （#448 PR2：Tauri 权威在后端 SQLite，缓存未 hydrate 时回落 localStorage）。
 */
import type { InputPredictionProvider, InputPredictionRequest } from '../../contracts/prediction.ts'
import type { InputPredictionSettings } from '../../domains/inputPrediction/inputPredictionSettings.ts'
import { cachedInputPredictionSettings } from '../../domains/inputPrediction/inputPredictionSettingsCache.ts'
import { boundPredictionHistory, boundPredictionMessages } from './inputPredictionProvider.ts'

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
    const settings = options.settings?.() ?? cachedInputPredictionSettings()
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
