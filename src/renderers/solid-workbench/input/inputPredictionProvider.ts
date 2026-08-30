import { createPredictionRateLimiter, normalizePredictionText, type PredictionRateLimiter } from './inputPredictionState.ts'

export interface InputPredictionRequest {
  readonly sessionId: string
  readonly generation?: number
  readonly draft: string
  readonly history: readonly string[]
  readonly signal: AbortSignal
}

export interface InputPredictionProvider {
  predict(request: InputPredictionRequest): Promise<string | null>
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
