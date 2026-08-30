export type PredictionSource = 'history' | 'llm'

export interface PredictionCandidate {
  readonly text: string
  readonly source: PredictionSource
}

/** Return the newest prior message that extends the current prefix. */
export function findHistoryCompletion(prefix: string, history: readonly string[]): string | null {
  if (!prefix || prefix.includes('\n')) return null
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const value = history[index]
    if (value && value.startsWith(prefix) && value.length > prefix.length) return value
  }
  return null
}

/** Merge durable (SQLite projected) and session-local history without duplicates. */
export function mergeHistory(...sources: readonly (readonly string[])[]): readonly string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const source of sources) {
    for (const value of source) {
      const normalized = value.trim()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      merged.push(normalized)
    }
  }
  return merged
}

export interface PredictionRateLimiter {
  canRequest(now?: number): boolean
  markRequested(now?: number): void
  reset(): void
}

/** Claude-like low frequency gate: one speculative request per cooldown window. */
export function createPredictionRateLimiter(cooldownMs = 15_000, clock: () => number = Date.now): PredictionRateLimiter {
  let lastRequest = -Infinity
  return {
    canRequest(now = clock()) { return now - lastRequest >= cooldownMs },
    markRequested(now = clock()) { lastRequest = now },
    reset() { lastRequest = -Infinity },
  }
}

