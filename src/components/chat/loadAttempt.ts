export interface LoadLockState {
  generations: ReadonlyMap<string, number>
}

export interface LoadFinishedDetail {
  source: string
  generation: number
}

export function createLoadLockState(): LoadLockState {
  return { generations: new Map() }
}

export function beginLoadLock(state: LoadLockState, source: string): { state: LoadLockState; generation: number } {
  const generation = (state.generations.get(source) ?? 0) + 1
  const generations = new Map(state.generations)
  generations.set(source, generation)
  return { state: { generations }, generation }
}

export function finishLoadLock(
  state: LoadLockState,
  source: string,
  generation: number,
): { state: LoadLockState; finished?: LoadFinishedDetail } {
  if (state.generations.get(source) !== generation) return { state }
  const generations = new Map(state.generations)
  generations.delete(source)
  return { state: { generations }, finished: { source, generation } }
}

export function isSendBlockedDuringLoad(state: LoadLockState, source: string): boolean {
  return state.generations.has(source)
}

export function shouldFlushQueuedSource(detail: LoadFinishedDetail, source: string | null): boolean {
  return source !== null && detail.source === source
}
