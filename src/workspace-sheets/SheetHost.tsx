import { useWorkspaceStore } from '../workspaceStore'
import { useIdentityStore } from '../identityStore'
import { resolveSheetRender } from './sheetRegistry.tsx'
import { resolveSessionSource } from '../components/chat/sessionCommandState'
import type { SheetContext, SheetRecord } from './sheetTypes'

/**
 * SheetHost — registry 驱动渲染（W1-02，F1-B）。
 *
 * 不再 switch(renderKey)：按 activeSheet.kind 查 SHEET_RENDER_REGISTRY 调用 entry.render。
 * 负责构建 SheetContext（布局层提供的 13 字段；sheet 自己能读的 store 不塞进 ctx）。
 */

interface SheetHostProps {
  activeSession: string | null
  onSelectSession: (id: string | null) => void
  onProfileEdit: () => void
  onSessionSettings: (id: string) => void
  sidebarCollapsed: boolean
  rightInset: number
  ccEditMode: boolean
}

function buildSheetContext(props: SheetHostProps): SheetContext {
  const { openSheet, focusSheet, closeSheet } = useWorkspaceStore.getState()
  return {
    openSheet,
    focusSheet,
    closeSheet,
    activeSession: props.activeSession,
    selectSession: props.onSelectSession,
    openProfileEdit: props.onProfileEdit,
    openSessionSettings: props.onSessionSettings,
    sidebarCollapsed: props.sidebarCollapsed,
    rightInset: props.rightInset,
    ccEditMode: props.ccEditMode,
    sessionSource: sessionId => resolveSessionSource(sessionId, useIdentityStore.getState().sessions),
    sessionBySource: source => useIdentityStore.getState().sessions.find(session => session.source === source),
  }
}

export default function SheetHost(props: SheetHostProps) {
  const sheets = useWorkspaceStore(s => s.workspaceSheets.sheets)
  const activeSheetId = useWorkspaceStore(s => s.workspaceSheets.activeSheetId)
  const activeSheet: SheetRecord | undefined = sheets.find(sheet => sheet.id === activeSheetId)

  if (!activeSheet) return <EmptySheetHost />
  const entry = resolveSheetRender(activeSheet.kind)
  if (!entry) return <UnavailableSheet kind={activeSheet.kind} />
  return entry.render(activeSheet, buildSheetContext(props))
}

function EmptySheetHost() {
  const openSheet = useWorkspaceStore(s => s.openSheet)
  return (
    <div className="sheet-empty-host">
      <div className="sheet-empty-kicker">WORKSPACE</div>
      <h2>没有打开的 Sheet</h2>
      <p>打开一个 Agent 工作现场，或从工具入口选择 Sheet。</p>
      <button type="button" onClick={() => openSheet({ kind: 'agent', title: 'Riccati', agentId: 'riccati' })}>
        打开 Riccati
      </button>
    </div>
  )
}

function UnavailableSheet({ kind }: { kind: string }) {
  return (
    <div className="sheet-empty-host">
      <div className="sheet-empty-kicker">SHEET</div>
      <h2>{kind} 尚未接入</h2>
      <p>当前只建立了 Sheet 状态与导航壳，运行内容尚未接入。</p>
    </div>
  )
}
