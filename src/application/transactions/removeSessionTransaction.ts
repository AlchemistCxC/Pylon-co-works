/**
 * removeSessionTransaction — 删除会话事务（报告阶段 3.2）。
 *
 * close_session 失败不静默删除（返回 transport，本地会话保留）；成功后按序：
 * removeSession（identity/runtime/workspace/sessionUiState 清理）→ 清消息缓存。
 * UI 收尾（关对话框/选中态）由调用方在 ok 后处理。
 */
import type { Session } from '../../identityStore'
import type { TransactionResult } from './transactionResult'

export interface RemoveSessionDeps {
  findSession: (id: string) => Session | undefined
  closeSession: (source: string) => Promise<unknown>
  removeSession: (id: string) => void
  clearMessages: (id: string) => void
  reportError: (action: string, error: unknown) => void
}

export async function removeSessionTransaction(id: string, deps: RemoveSessionDeps): Promise<TransactionResult<string>> {
  const session = deps.findSession(id)
  if (!session) return { ok: false, kind: 'validation', message: '会话不存在' }
  try {
    await deps.closeSession(session.source)
  } catch (error) {
    deps.reportError('关闭会话', error)
    return { ok: false, kind: 'transport', message: error instanceof Error ? error.message : '关闭会话失败', cause: error }
  }
  deps.removeSession(id)
  deps.clearMessages(id)
  return { ok: true, value: id }
}
