export type RenderMetricName =
  | 'ChatView.render'
  | 'MessageRow.render'
  | 'AssistantContent.render'
  | 'ReasoningBlock.render'
  | 'ToolCard.render'
  | 'CodeBlock.render'
  | 'messages.map'
  | 'highlightCode.call'
  | 'scrollIntoView.call'
  | 'streamingText.render'
  | 'streamingThinking.render'

export interface RenderMetricSnapshot {
  counts: Record<RenderMetricName, number>
  measures: Record<string, { count: number; totalMs: number; maxMs: number }>
  startedAt: number
}

type MutableMetric = { count: number; totalMs: number; maxMs: number }

const METRIC_NAMES: RenderMetricName[] = [
  'ChatView.render',
  'MessageRow.render',
  'AssistantContent.render',
  'ReasoningBlock.render',
  'ToolCard.render',
  'CodeBlock.render',
  'messages.map',
  'highlightCode.call',
  'scrollIntoView.call',
  'streamingText.render',
  'streamingThinking.render',
]

const enabled = import.meta.env.DEV
const counts = Object.fromEntries(METRIC_NAMES.map(name => [name, 0])) as Record<RenderMetricName, number>
const measures = new Map<string, MutableMetric>()
const startedAt = typeof performance !== 'undefined' ? performance.now() : 0

function addMeasure(name: string, durationMs: number) {
  const current = measures.get(name) || { count: 0, totalMs: 0, maxMs: 0 }
  current.count += 1
  current.totalMs += durationMs
  current.maxMs = Math.max(current.maxMs, durationMs)
  measures.set(name, current)
}

function snapshot(): RenderMetricSnapshot {
  return {
    counts: { ...counts },
    measures: Object.fromEntries([...measures.entries()].map(([name, value]) => [name, { ...value }])),
    startedAt,
  } as RenderMetricSnapshot
}

function installDevApi() {
  if (!enabled || typeof window === 'undefined') return
  const target = window as typeof window & {
    __PYLON_RENDER_METRICS__?: {
      snapshot: () => RenderMetricSnapshot
      reset: () => void
    }
  }
  target.__PYLON_RENDER_METRICS__ = {
    snapshot,
    reset: () => {
      for (const name of METRIC_NAMES) counts[name] = 0
      measures.clear()
    },
  }
}

installDevApi()

export function recordRender(name: RenderMetricName) {
  if (!enabled) return
  counts[name] += 1
}

export function measureRender<T>(name: string, callback: () => T): T {
  if (!enabled || typeof performance === 'undefined') {
    return callback()
  }
  const start = performance.now()
  const result = callback()
  addMeasure(name, performance.now() - start)
  return result
}

export function recordMeasuredAsync<T>(name: string, promise: Promise<T>): Promise<T> {
  if (!enabled || typeof performance === 'undefined') return promise
  const start = performance.now()
  return promise.finally(() => addMeasure(name, performance.now() - start))
}

export function recordPerformanceMeasure(name: string, callback: () => void) {
  if (!enabled || typeof performance === 'undefined' || typeof performance.mark !== 'function') {
    callback()
    return
  }
  const startMark = `${name}:start`
  const endMark = `${name}:end`
  performance.mark(startMark)
  try {
    callback()
  } finally {
    performance.mark(endMark)
    performance.measure(name, startMark, endMark)
    performance.clearMarks(startMark)
    performance.clearMarks(endMark)
  }
}
