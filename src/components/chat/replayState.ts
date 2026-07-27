export interface ReplayEventMeta {
  replay?: boolean
}

export interface LoadedMessages<T> {
  loadSucceeded: boolean
  cached: T[]
  replayed: T[]
}

export function shouldStartLiveGeneration(event: ReplayEventMeta): boolean {
  return event.replay !== true
}

export function resolveLoadedMessages<T>({ loadSucceeded, cached, replayed }: LoadedMessages<T>): T[] {
  return loadSucceeded ? replayed : cached
}

export function serializeLoadedMessages<T>(messages: T[]): string | null {
  return messages.length > 0 ? JSON.stringify(messages) : null
}
