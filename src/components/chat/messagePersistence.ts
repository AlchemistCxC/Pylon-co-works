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

// 2026-08-02：消息快照加版本 envelope（旧数据为裸数组，读取时兼容迁移——
// 下次写入自动升级为 envelope；schema 变更时 bump 版本并在 parse 里分支迁移）。
export const MESSAGE_SNAPSHOT_VERSION = 1

interface MessageSnapshotEnvelope<T> {
  version: number
  messages: T[]
}

function isEnvelope(value: unknown): value is MessageSnapshotEnvelope<unknown> {
  return !!value && typeof value === 'object' && 'version' in value && Array.isArray((value as { messages?: unknown }).messages)
}

/** 读取并解析快照：envelope（新）与裸数组（v1 前旧数据）均接受；损坏返回 null。 */
export function parseMessageSnapshot<T>(raw: string | null): T[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isEnvelope(parsed)) return parsed.messages as T[]
    if (Array.isArray(parsed)) return parsed as T[]
    return null
  } catch {
    return null
  }
}

export function persistMessageSnapshot<T>(sessionId: string, messages: T[], storage: MessageStorage): void {
  const key = messageStorageKey(sessionId)
  if (messages.length === 0) {
    storage.removeItem(key)
    return
  }
  const envelope: MessageSnapshotEnvelope<T> = { version: MESSAGE_SNAPSHOT_VERSION, messages }
  storage.setItem(key, JSON.stringify(envelope))
}

export function clearMessageStorage(sessionId: string, storage: Pick<MessageStorage, 'removeItem'>): void {
  storage.removeItem(messageStorageKey(sessionId))
}
