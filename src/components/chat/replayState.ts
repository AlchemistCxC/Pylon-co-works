export interface ReplayEventMeta {
  replay?: boolean
}

export interface LoadedMessages<T> {
  loadSucceeded: boolean
  cached: T[]
  replayed: T[]
}

export interface ReplayEventState {
  eventReplay: boolean
  loadInProgress: boolean
}

export function isReplayEvent({ eventReplay, loadInProgress }: ReplayEventState): boolean {
  return eventReplay || loadInProgress
}

export function shouldStartLiveGeneration(event: ReplayEventMeta): boolean {
  return event.replay !== true
}

export function resolveLoadedMessages<T>({ loadSucceeded, cached, replayed }: LoadedMessages<T>): T[] {
  if (!loadSucceeded || replayed.length === 0) return cached
  return replayed
}

export function serializeLoadedMessages<T>(messages: T[]): string | null {
  return messages.length > 0 ? JSON.stringify(messages) : null
}
