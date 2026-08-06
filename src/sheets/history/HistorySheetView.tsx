import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { reportRuntimeError } from '../../runtimeError'
import { pagePersistedSessions, validateExportPath } from '../../domains/history/persistedHistory.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'
import './HistorySheet.css'

/**
 * HistorySheetView — 存档会话列表 + 导出（W4-01）。
 *
 * list_persisted_sessions 分页/排序（复用 overview normalize）；导出经 save 对话框
 * 取绝对路径 → export_session（预检路径绝对；目标文件已存在错误明确展示，后端权威）。
 */
export default function HistorySheetView({ sheet: _sheet, ctx: _ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const [raw, setRaw] = useState<unknown>(null)
  const [page, setPage] = useState(1)
  const [exportError, setExportError] = useState('')

  useEffect(() => {
    let disposed = false
    invoke<unknown>('list_persisted_sessions').then(value => {
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
      await invoke('export_session', { periId, format: 'markdown', outputPath })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setExportError(message)
      reportRuntimeError('导出会话', error)
    }
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
