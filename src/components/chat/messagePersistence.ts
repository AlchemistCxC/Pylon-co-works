export interface MessagePersistenceOwner {
  ownerId: string | null
  source: string | null
  renderedSessionId: string | null
}

export function canPersistMessages({ ownerId, source, renderedSessionId }: MessagePersistenceOwner): boolean {
  return Boolean(ownerId && source && ownerId === renderedSessionId)
}

export function messageStorageKey(sessionId: string): string {
  return `pylon-msgs-${sessionId}`
}

export interface MessageStorage {
  removeItem: (key: string) => void
}

export function clearMessageStorage(sessionId: string, storage: MessageStorage): void {
  storage.removeItem(messageStorageKey(sessionId))
}
