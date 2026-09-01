import { createPredictionRateLimiter, normalizePredictionText, type PredictionRateLimiter } from './inputPredictionState.ts'

export interface InputPredictionRequest {
  readonly sessionId: string
  readonly generation?: number
  readonly draft: string
  readonly history: readonly string[]
  /** Canonical bounded conversation transcript (assistant + user turns). */
  readonly messages?: readonly { role: 'user' | 'assistant'; content: string }[]
  readonly signal: AbortSignal
}

export interface InputPredictionProvider {
  predict(request: InputPredictionRequest): Promise<string | null>
}

export interface HttpPredictionProviderOptions {
  /** Local or remote endpoint that accepts a JSON prediction request. */
  readonly endpoint: string | URL
  /** Injectable for tests; defaults to the browser/host fetch implementation. */
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: HeadersInit
  /** Bound the durable history sent to the model (newest entries win). */
  readonly maxHistoryItems?: number
  readonly maxHistoryChars?: number
}

export interface PredictionHttpPayload {
  readonly sessionId: string
  readonly generation?: number
  readonly draft: string
  readonly history: readonly string[]
  readonly messages?: readonly { role: 'user' | 'assistant'; content: string }[]
}

/**
 * Keep prediction context bounded even when the SQLite transcript is large.
 * Ordering is retained; the newest messages are preferred when truncating.
 */
export function boundPredictionHistory(
  history: readonly string[],
  options: Pick<HttpPredictionProviderOptions, 'maxHistoryItems' | 'maxHistoryChars'> = {},
): readonly string[] {
  const maxItems = Math.max(0, Math.floor(options.maxHistoryItems ?? 24))
  const maxChars = Math.max(0, Math.floor(options.maxHistoryChars ?? 6_000))
  if (maxItems === 0 || maxChars === 0) return []
  const selected: string[] = []
  let chars = 0
  for (let index = history.length - 1; index >= 0 && selected.length < maxItems; index -= 1) {
    const value = history[index]?.trim()
    if (!value) continue
    const nextChars = chars + value.length
    if (nextChars > maxChars) continue
    selected.push(value)
    chars = nextChars
  }
  selected.reverse()
  return selected
}

export function boundPredictionMessages(
  messages: readonly { role: 'user' | 'assistant'; content: string }[],
  options: Pick<HttpPredictionProviderOptions, 'maxHistoryItems' | 'maxHistoryChars'> = {},
): readonly { role: 'user' | 'assistant'; content: string }[] {
  const maxItems = Math.max(0, Math.floor(options.maxHistoryItems ?? 24))
  const maxChars = Math.max(0, Math.floor(options.maxHistoryChars ?? 6_000))
  const selected: { role: 'user' | 'assistant'; content: string }[] = []
  let chars = 0
  for (let index = messages.length - 1; index >= 0 && selected.length < maxItems; index -= 1) {
    const item = messages[index]
    const content = item?.content?.trim()
    if (!content) continue
    if (chars + content.length > maxChars) continue
    selected.push({ role: item.role, content })
    chars += content.length
  }
  return selected.reverse()
}

function extractPredictionPayload(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const key of ['suggestion', 'prediction', 'text']) {
    const v = record[key]
    if (typeof v === 'string') return v
  }
  const nested = record.data
  return nested && typeof nested === 'object'
    ? extractPredictionPayload(nested)
    : null
}

/**
 * Concrete provider seam for a local sidecar or remote prediction service.
 * The scheduler owns debounce, cancellation and cooldown; this adapter only
 * performs one bounded request and deliberately returns null for malformed or
 * non-2xx responses so the UI can fall back to history completion.
 */
export function createHttpPredictionProvider(options: HttpPredictionProviderOptions): InputPredictionProvider {
  const endpoint = String(options.endpoint).trim()
  if (!endpoint) throw new Error('预测 provider endpoint 不能为空')
  const request = options.fetch ?? globalThis.fetch
  return {
    async predict(input): Promise<string | null> {
      if (input.signal.aborted) return null
      const payload: PredictionHttpPayload = {
        sessionId: input.sessionId,
        ...(input.generation === undefined ? {} : { generation: input.generation }),
        draft: input.draft,
        history: boundPredictionHistory(input.history, options),
        ...(input.messages ? { messages: input.messages } : {}),
      }
      const response = await request(endpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(payload),
        signal: input.signal,
      })
      if (!response.ok) return null
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return null
      }
      return extractPredictionPayload(body)
    },
  }
}

export interface PredictionScheduler {
  schedule(request: Omit<InputPredictionRequest, 'signal'>, onResult: (value: string | null) => void): void
  cancel(): void
  dispose(): void
}

interface PredictionSchedulerOptions {
  debounceMs?: number
  limiter?: PredictionRateLimiter
  clock?: () => number
}

/** Debounced, cancellable provider boundary. Results from stale session/generation are dropped. */
export function createPredictionScheduler(
  provider: InputPredictionProvider,
  options: PredictionSchedulerOptions = {},
): PredictionScheduler {
  const debounceMs = options.debounceMs ?? 400
  const limiter = options.limiter ?? createPredictionRateLimiter(15_000, options.clock)
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let sequence = 0
  let disposed = false

  const cancel = () => {
    sequence += 1
    if (timer !== undefined) globalThis.clearTimeout(timer)
    timer = undefined
    controller?.abort()
    controller = undefined
  }

  return {
    schedule(request, onResult) {
      cancel()
      if (disposed || !limiter.canRequest()) return
      const current = ++sequence
      timer = globalThis.setTimeout(() => {
        timer = undefined
        if (disposed || current !== sequence) return
        limiter.markRequested()
        const nextController = new AbortController()
        controller = nextController
        void provider.predict({ ...request, signal: nextController.signal }).then(value => {
          if (!disposed && current === sequence && !nextController.signal.aborted) onResult(normalizePredictionText(value))
        }).catch(() => {
          // Provider failures are intentionally silent; the local history path remains available.
        }).finally(() => {
          if (controller === nextController) controller = undefined
        })
      }, Math.max(0, debounceMs))
    },
    cancel,
    dispose() {
      if (disposed) return
      disposed = true
      cancel()
    },
  }
}
