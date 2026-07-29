export interface MessagePersistenceOwner {
  ownerId: string | null
  source: string | null
  renderedSessionId: string | null
  renderedSource: string | null
}

export function canPersistMessages({ ownerId, source, renderedSessionId, renderedSource }: MessagePersistenceOwner): boolean {
  return Boolean(
    ownerId
    && source
    && renderedSessionId
    && renderedSource
    && ownerId === renderedSessionId
    && source === renderedSource,
  )
}

export function messageStorageKey(sessionId: string): string {
  return `pylon-msgs-${sessionId}`
}

export interface MessageStorage {
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export function persistMessageSnapshot<T>(sessionId: string, messages: T[], storage: MessageStorage): void {
  const key = messageStorageKey(sessionId)
  if (messages.length === 0) {
    storage.removeItem(key)
    return
  }
  storage.setItem(key, JSON.stringify(messages))
}

export function clearMessageStorage(sessionId: string, storage: Pick<MessageStorage, 'removeItem'>): void {
  storage.removeItem(messageStorageKey(sessionId))
}
