export interface LoadedMessages<T> {
  loadSucceeded: boolean
  cached: T[]
  replayed: T[]
}

export function normalizeToolId(toolCallId: unknown): string | null {
  if (typeof toolCallId !== 'string') return null
  const value = toolCallId.trim()
  return value.length > 0 ? value : null
}

export function shouldAcceptToolCall(toolCallId: unknown, seenIds: string[]): boolean {
  const normalized = normalizeToolId(toolCallId)
  return normalized !== null && !seenIds.includes(normalized)
}

export function nextLoadGeneration(current: number | undefined): number {
  return (current ?? 0) + 1
}

export function isCurrentLoadGeneration(current: number | undefined, expected: number): boolean {
  return current === expected
}

export function resolveLoadedMessages<T>({ loadSucceeded, cached, replayed }: LoadedMessages<T>): T[] {
  if (!loadSucceeded || replayed.length === 0) return cached
  return replayed
}

export function serializeLoadedMessages<T>(messages: T[]): string | null {
  return messages.length > 0 ? JSON.stringify(messages) : null
}
