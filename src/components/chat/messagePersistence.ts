export interface MessagePersistenceOwner {
  ownerId: string | null
  source: string | null
  renderedSessionId: string | null
}

export function canPersistMessages({ ownerId, source, renderedSessionId }: MessagePersistenceOwner): boolean {
  return Boolean(ownerId && source && ownerId === renderedSessionId)
}