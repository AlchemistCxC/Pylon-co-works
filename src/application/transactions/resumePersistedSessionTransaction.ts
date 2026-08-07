/**
 * resumePersistedSessionTransaction — 恢复存档会话事务（报告阶段 3.3 / FE-AUD-010）。
 *
 * 按 source/periId ensure 本地 identity 行：命中复用，未命中 addSession（返回 id，
 * 不靠数组长度定位）并纠正 source/periId/updatedAt。Overview/History 共用，
 * 只传导航策略（selectSession/openSheet/姿态），不再各自重复找/建逻辑。
 */
import type { Session } from '../../identityStore'
import type { TransactionResult } from './transactionResult'

export interface ResumeSessionDeps {
  sessions: readonly Session[]
  addSession: (name: string) => string
  updateSession: (id: string, partial: Partial<Session>) => void
}

export function resumePersistedSessionTransaction(
  source: string | undefined,
  periId: string | undefined,
  title: string | undefined,
  updatedAt: number | undefined,
  deps: ResumeSessionDeps,
): TransactionResult<string> {
  const existing = deps.sessions.find(session =>
    (source !== undefined && session.source === source) ||
    (periId !== undefined && session.periId === periId))
  if (existing) return { ok: true, value: existing.id }

  const name = title || `session-${Date.now().toString(36)}`
  let id: string
  try {
    id = deps.addSession(name)
  } catch (error) {
    return { ok: false, kind: 'transport', message: error instanceof Error ? error.message : '创建会话失败', cause: error }
  }
  if (!id) return { ok: false, kind: 'validation', message: '会话创建失败' }
  deps.updateSession(id, {
    ...(source ? { source } : {}),
    ...(periId ? { periId } : {}),
    lastActiveAt: updatedAt || Date.now(),
  })
  return { ok: true, value: id }
}
