/**
 * resumePersistedSessionTransaction — 恢复存档会话事务（报告阶段 3.3 / FE-AUD-010）。
 *
 * 按 source/periId ensure 本地 identity 行：命中复用，未命中 addSession（返回 id，
 * 不靠数组长度定位）并纠正 source/periId/updatedAt。Overview/History 共用，
 * 只传导航策略（selectSession/openSheet/姿态），不再各自重复找/建逻辑。
 *
 * ISSUE-01：传入 agentId（可选末参，保持既有 sheet 调用方兼容）时只在该 owner 的
 * 会话内匹配 source/periId——不同 Agent 的同 source 存档各自成行；若 source 与
 * periId 同时命中但指向不同 Session，判定为冲突（conflict），不静默合并。
 */
import type { Session } from '../../identityStore'
import type { TransactionResult } from './transactionResult'

export interface ResumeSessionDeps {
  sessions: readonly Session[]
  addSession: (name: string, agentId?: string) => string
  updateSession: (id: string, partial: Partial<Session>) => void
}

export function resumePersistedSessionTransaction(
  source: string | undefined,
  periId: string | undefined,
  title: string | undefined,
  updatedAt: number | undefined,
  deps: ResumeSessionDeps,
  agentId?: string,
): TransactionResult<string> {
  const scoped = agentId ? deps.sessions.filter(session => session.agentId === agentId) : deps.sessions
  const bySource = source !== undefined ? scoped.find(session => session.source === source) : undefined
  const byPeriId = periId !== undefined ? scoped.find(session => session.periId === periId) : undefined
  if (bySource && byPeriId && bySource.id !== byPeriId.id) {
    return { ok: false, kind: 'conflict', message: '存档会话归属冲突：source 与 periId 指向不同会话，需显式选择' }
  }
  const existing = bySource ?? byPeriId
  if (existing) return { ok: true, value: existing.id }

  const name = title || `session-${Date.now().toString(36)}`
  let id: string
  try {
    id = deps.addSession(name, agentId)
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
