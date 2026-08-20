import type { Session } from '../../identityStore'
import type { TransactionResult } from './transactionResult'

export type ArchivedOwnerResolution =
  | { kind: 'resolved'; agentId: string; sessionId: string }
  | { kind: 'missing' }
  | { kind: 'conflict'; sessionIds: string[] }

export interface ArchivedOwnerResolverInput {
  source?: string
  periId?: string
  ownerAgentId?: string
}

/**
 * ISSUE-01 W7：统一 archive owner resolver。
 *
 * source/periId 任一唯一命中即可恢复；两者命中不同 Session，或同一身份命中多个
 * Session，都必须显式返回 conflict。ownerAgentId 存在时只在该 owner scope 内解析。
 */
export function resolveArchivedSessionOwner(
  input: ArchivedOwnerResolverInput,
  sessions: readonly Session[],
): ArchivedOwnerResolution {
  const scoped = input.ownerAgentId
    ? sessions.filter(session => session.agentId === input.ownerAgentId)
    : sessions
  const matched = scoped.filter(session =>
    (input.source !== undefined && session.source === input.source)
      || (input.periId !== undefined && session.periId === input.periId),
  )
  const ids = [...new Set(matched.map(session => session.id))]
  if (ids.length === 0) return { kind: 'missing' }
  if (ids.length > 1) return { kind: 'conflict', sessionIds: ids }
  const target = matched[0]
  return { kind: 'resolved', agentId: target.agentId, sessionId: target.id }
}

export function archivedOwnerResultToTransaction(
  result: ArchivedOwnerResolution,
): TransactionResult<{ agentId: string; sessionId: string }> {
  if (result.kind === 'resolved') return { ok: true, value: { agentId: result.agentId, sessionId: result.sessionId } }
  if (result.kind === 'missing') return { ok: false, kind: 'validation', message: '存档会话不存在对应本地归属' }
  return { ok: false, kind: 'conflict', message: '存档会话归属冲突：source/periId 指向多个本地会话' }
}
