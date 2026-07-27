export function updateSourceState<T>(
  state: Record<string, T[]>,
  source: string,
  updater: (current: T[]) => T[],
): T[] {
  const next = updater(state[source] || [])
  state[source] = next
  return next
}

export function addGeneratingSource(sources: string[], source: string): string[] {
  return sources.includes(source) ? sources : [...sources, source]
}

export function removeGeneratingSource(sources: string[], source: string): string[] {
  return sources.filter(item => item !== source)
}
