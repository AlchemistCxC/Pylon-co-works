import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { reportRuntimeError } from '../../runtimeError'
import { useIdentityStore } from '../../identityStore'
import { createSessionClient } from '../../infrastructure/acp/sessionClient'
import { resumePersistedSessionTransaction } from '../../application/transactions/resumePersistedSessionTransaction'
import { useReplayPostureStore } from '../../components/chat/replayPostureStore'
import { pagePersistedSessions, validateExportPath } from '../../domains/history/persistedHistory.ts'
import { type PersistedSessionSummary } from '../../domains/overview/persistedSessions.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'
import './HistorySheet.css'

/**
 * HistorySheetView — 存档会话列表 + 导出（W4-01）+ 回放入口（W4-02）。
 *
 * list_persisted_sessions 分页/排序（复用 overview normalize）；导出经 save 对话框
 * 取绝对路径 → export_session（预检路径绝对；目标文件已存在错误明确展示，后端权威）。
 * W4-02（姿态二拍板）：行「回放」复用 Overview resumeSession 机制（找/建 identity 行）
 * → 进入只读姿态 → 开 agent sheet；消息 load 由 ChatView 挂载后 lifecycle 承担
 * （load_persisted_session，listener 先于 load），姿态下无输入面直至点击继续。
 */
export default function HistorySheetView({ sheet: _sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const [raw, setRaw] = useState<unknown>(null)
  const [page, setPage] = useState(1)
  const [exportError, setExportError] = useState('')
  const activeAgent = useIdentityStore(s => s.activeAgent) || 'peri'

  useEffect(() => {
    let disposed = false
    const client = createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
    client.listPersistedSessions().then(value => {
      if (!disposed) setRaw(value)
    }).catch(error => reportRuntimeError('读取存档会话', error))
    return () => { disposed = true }
  }, [])

  const paged = useMemo(() => pagePersistedSessions(raw, page), [raw, page])

  const exportSession = async (periId: string) => {
    setExportError('')
    const outputPath = await save({ defaultPath: `session-${periId}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (!outputPath) return
    const validation = validateExportPath(outputPath)
    if (validation) { setExportError(validation); return }
    try {
      const client = createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
      await client.exportSession({ periId, format: 'markdown', outputPath })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setExportError(message)
      reportRuntimeError('导出会话', error)
    }
  }

  // W4-02（姿态二）：复用 Overview 的找/建 identity 行机制（resumePersistedSessionTransaction，
  // FE-AUD-010），进入只读姿态后开 agent sheet；load 由 ChatView 挂载后的 lifecycle 承担
  const openReplay = (entry: PersistedSessionSummary) => {
    setExportError('')
    if (!entry.periId) return
    const result = resumePersistedSessionTransaction(entry.source, entry.periId, entry.title, entry.updatedAt, {
      sessions: useIdentityStore.getState().sessions,
      addSession: name => useIdentityStore.getState().addSession(name),
      updateSession: (id, partial) => useIdentityStore.getState().updateSession(id, partial),
    })
    if (!result.ok) return
    useReplayPostureStore.getState().enter(result.value)
    ctx.selectSession(result.value)
    ctx.openSheet({ kind: 'agent', title: entry.title || 'Agent', agentId: activeAgent })
  }

  return (
    <div className="history-sheet">
      <div className="file-main-kicker">HISTORY</div>
      <h2 className="file-main-title">存档会话（{paged.total}）</h2>
      {exportError && <div className="file-tree-error" role="alert">{exportError}</div>}
      <ul className="search-result-list">
        {paged.entries.map(entry => (
          <li key={entry.id}>
            <div className="history-row">
              <span className="search-result-path">{entry.title || entry.source || entry.id}</span>
              <span className="search-result-text">{new Date(entry.updatedAt).toLocaleString()}</span>
              <button type="button" className="template-apply" disabled={!entry.periId} title={entry.periId ? '只读回放，点击继续转 live' : '该存档无 periId，无法回放'} onClick={() => openReplay(entry)}>回放</button>
              <button type="button" className="template-apply" onClick={() => void exportSession(entry.periId || entry.id)}>导出</button>
            </div>
          </li>
        ))}
      </ul>
      {paged.pages > 1 && (
        <div className="history-pager">
          <button type="button" className="template-apply" disabled={paged.page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button>
          <span className="file-section-hint">{paged.page}/{paged.pages}</span>
          <button type="button" className="template-apply" disabled={paged.page >= paged.pages} onClick={() => setPage(p => p + 1)}>下一页</button>
        </div>
      )}
    </div>
  )
}
