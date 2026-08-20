/**
 * removeSessionTransaction — 删除会话事务（报告阶段 3.2 + I14-W7 + DEL-03 §5.13 本地优先）。
 *
 * DEL-03（§5.13）本地优先删除顺序：不再以远端 close 结果决定是否删除——
 *   本地删除（OwnerKey 校验 → deleting tombstone → 本地事务删除用户记录/消息）→
 *   markDeleted（主动 cancel 调度器未落盘写，DEL-04）→ 清理 UI/localStorage →
 *   远端 close best effort（失败仅报告，不阻断本地删除）→
 *   终态化（deleting → deleted，best effort）。
 * 本地删除失败仍返回 transport（可重试），本地会话保留；远端 close/finalize 失败不回滚
 * 已完成的本地删除。UI 收尾（关对话框/选中态）由调用方在 ok 后处理。
 */
import type { Session } from '../../identityStore'
import type { TransactionResult } from './transactionResult'
import { toCanonicalOwnerKey } from '../../domains/events/eventSchema'

export function sessionDurableOwnerKey(session: Session): string {
  return toCanonicalOwnerKey({
    profileId: session.profileId,
    agentId: session.agentId,
    localSessionId: session.source,
  })
}

export interface RemoveSessionDeps {
  findSession: (id: string) => Session | undefined
  /** DEL-03（§5.13 步骤 1-4）：本地优先删除（OwnerKey 校验 + deleting tombstone + 本地事务删除）；失败 → 可重试错误 */
  deleteSessionLocal: (session: Session) => Promise<unknown>
  /** DEL-04（§5.13）：删除终态——主动 cancel/mark deleted（清调度器 timer/dirty/revision 并
   *  拒绝该 session 的迟到写）；dispose() 只清 dirty 不是删除语义，必须显式调用 */
  markSessionDeleted: (sessionId: string) => void
  /** OWNER-02：close 目标 owner 由 session 携带（agentId + source 一并传递，绝不取 activeAgent）——best effort，失败仅报告 */
  closeSession: (session: Session) => Promise<unknown>
  /** DEL-03 终态化：deleting → deleted（best effort，失败仅报告） */
  finalizeSessionDelete: (session: Session) => Promise<unknown>
  removeSession: (id: string) => void
  clearMessages: (id: string) => void
  reportError: (action: string, error: unknown) => void
}

export async function removeSessionTransaction(id: string, deps: RemoveSessionDeps): Promise<TransactionResult<string>> {
  const session = deps.findSession(id)
  if (!session) return { ok: false, kind: 'validation', message: '会话不存在' }
  // DEL-03（§5.13 本地优先）：先本地删除（OwnerKey 校验 → deleting tombstone → 本地事务删除）——失败可重试，本地会话保留
  try {
    await deps.deleteSessionLocal(session)
  } catch (error) {
    deps.reportError('删除会话记录', error)
    return { ok: false, kind: 'transport', message: error instanceof Error ? error.message : '删除会话失败', cause: error }
  }
  // 本地删除成功即完成：DEL-04 主动 cancel 调度器未落盘写（不得复活）→ 清理 UI/localStorage
  deps.markSessionDeleted(id)
  deps.removeSession(id)
  deps.clearMessages(id)
  // §5.13 远端 close best effort：失败仅报告，不阻断本地删除
  try {
    await deps.closeSession(session)
  } catch (error) {
    deps.reportError('关闭会话', error)
  }
  // §5.13 终态化：deleting → deleted（best effort，失败仅报告；tombstone 保持 deleting 仍 gate 迟到写）
  try {
    await deps.finalizeSessionDelete(session)
  } catch (error) {
    deps.reportError('确认删除', error)
  }
  return { ok: true, value: id }
}
