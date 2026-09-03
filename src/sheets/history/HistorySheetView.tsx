import { useEffect, useMemo, useState } from 'react'
import { Archive, ChevronFirst, ChevronLast } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { reportRuntimeError, resolveRuntimeErrors } from '../../runtimeError.ts'
import { useIdentityStore } from '../../identityStore'
import { createSessionClient } from '../../infrastructure/acp/sessionClient'
import { createStandardSwitchAgent, openOwnedSessionTransaction } from '../../application/transactions/openOwnedSessionTransaction'
import { useReplayPostureStore } from '../../components/chat/replayPostureStore'
import { pagePersistedSessions, validateExportPath } from '../../domains/history/persistedHistory.ts'
import { type PersistedSessionSummary } from '../../domains/overview/persistedSessions.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

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
  const [replayError, setReplayError] = useState('')

  useEffect(() => {
    let disposed = false
    const client = createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
    client.listPersistedSessions().then(value => {
      if (!disposed) {
        setRaw(value)
        resolveRuntimeErrors({ key: `history:${_sheet.id}:list` })
      }
    }).catch(error => {
      if (!disposed) reportRuntimeError('读取存档会话', error, undefined, {
        key: `history:${_sheet.id}:list`,
        scope: { kind: 'sheet', id: _sheet.id },
        source: 'history.sheet',
        recovery: { kind: 'open-runtime-log', sheetId: _sheet.id },
      })
    })
    return () => { disposed = true }
  }, [_sheet.id])

  const paged = useMemo(() => pagePersistedSessions(raw, page), [raw, page])
  const sidebarPages = useMemo(() => {
    const start = Math.max(1, Math.min(paged.page - 3, paged.pages - 6))
    return Array.from({ length: Math.min(7, paged.pages) }, (_, index) => start + index)
  }, [paged.page, paged.pages])

  const exportSession = async (periId: string) => {
    setExportError('')
    setReplayError('')
    // OWNER-02：export owner agentId 从 Session owner 解析（identityStore 按 periId 定位），
    // 绝不取 activeAgent；未定位到 owner 时明确报错（不静默 fallback 串线）。
    const owner = useIdentityStore.getState().sessions.find(s => s.periId === periId)
    if (!owner) { setExportError('无法确定会话归属 Agent，请先在会话中打开再导出'); return }
    let outputPath: string | null
    try {
      outputPath = await save({ defaultPath: `session-${periId}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
    } catch (error) {
      reportRuntimeError('打开导出保存对话框', error, undefined, {
        key: `history:${_sheet.id}:export-dialog`,
        scope: { kind: 'sheet', id: _sheet.id },
        source: 'history.sheet',
        recovery: { kind: 'open-runtime-log', sheetId: _sheet.id },
      })
      return
    }
    if (!outputPath) return
    const validation = validateExportPath(outputPath)
    if (validation) { setExportError(validation); return }
    try {
      const client = createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
      await client.exportSession({ agentId: owner.agentId, periId, format: 'markdown', outputPath })
      resolveRuntimeErrors({ key: `history:${_sheet.id}:export:${periId}` })
    } catch (error) {
      setExportError('')
      reportRuntimeError('导出会话', error, undefined, {
        key: `history:${_sheet.id}:export:${periId}`,
        scope: { kind: 'sheet', id: _sheet.id },
        source: 'history.sheet',
        recovery: { kind: 'open-runtime-log', sheetId: _sheet.id },
      })
    }
  }

  // W4-02（姿态二）：复用 Overview 的找/建 identity 行机制（resumePersistedSessionTransaction，
  // FE-AUD-010），进入只读姿态后开 agent sheet；load 由 ChatView 挂载后的 lifecycle 承担
  const openReplay = async (entry: PersistedSessionSummary) => {
    setExportError('')
    setReplayError('')
    if (!entry.periId) return
    // I01-W4：owner-aware 打开——owner 无法确定（存档无归属）时 blocked，不静默归 active Agent
    const result = await openOwnedSessionTransaction(
      { source: entry.source, periId: entry.periId, title: entry.title, updatedAt: entry.updatedAt },
      {
        getSessions: () => useIdentityStore.getState().sessions,
        activeAgent: useIdentityStore.getState().activeAgent,
        addSession: (name, agentId) => useIdentityStore.getState().addSession(name, agentId),
        updateSession: (id, partial) => useIdentityStore.getState().updateSession(id, partial),
        switchAgent: createStandardSwitchAgent(id => useIdentityStore.getState().agents.find(a => a.id === id)?.name),
        selectSession: id => ctx.selectSession(id),
        openAgentSheet: ({ title, agentId }) => ctx.openSheet({ kind: 'agent', title, agentId }),
      },
    )
    if (!result.ok) {
      // Owner-switch transport failures are already recorded in the central
      // tray by createStandardSwitchAgent. Keep a quiet contextual status;
      // ownership/validation facts remain assertive and actionable here.
      if (result.kind === 'transport') setReplayError('回放失败，详情见右下角错误中心')
      else setExportError(result.message)
      return
    }
    useReplayPostureStore.getState().enter(result.value)
  }

  return (
    <div className="history-sheet">
      {!ctx.sidebarCollapsed && (
        <aside className="history-sidebar" aria-label="存档导航">
          <div className="history-sidebar-head"><span>HISTORY</span><strong>存档导航</strong></div>
          <div className="history-sidebar-total"><Archive size={16} aria-hidden="true" /><span><strong>{paged.total}</strong> 个存档</span></div>
          {paged.pages > 1 && (
            <nav aria-label="存档分页">
              <button type="button" disabled={paged.page === 1} onClick={() => setPage(1)} aria-label="第一页"><ChevronFirst size={15} aria-hidden="true" /><span>第一页</span></button>
              {sidebarPages.map(pageNumber => <button type="button" key={pageNumber} className={pageNumber === paged.page ? 'is-active' : ''} aria-current={pageNumber === paged.page ? 'page' : undefined} onClick={() => setPage(pageNumber)}><span>第 {pageNumber} 页</span></button>)}
              <button type="button" disabled={paged.page === paged.pages} onClick={() => setPage(paged.pages)} aria-label="最后一页"><ChevronLast size={15} aria-hidden="true" /><span>最后一页</span></button>
            </nav>
          )}
          <div className="history-sidebar-foot">第 {paged.page} / {paged.pages} 页</div>
        </aside>
      )}
      <main className="history-main">
        <div className="file-main-kicker">HISTORY</div>
        <h2 className="file-main-title">存档会话（{paged.total}）</h2>
        {exportError && <div className="file-tree-error" role="alert">{exportError}</div>}
        {replayError && <p className="file-section-hint history-error-reference" role="status">{replayError}</p>}
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
      </main>
    </div>
  )
}
