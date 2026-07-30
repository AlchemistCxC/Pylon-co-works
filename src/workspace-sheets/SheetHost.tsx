import { useStore } from '../store'
import { SHEET_REGISTRY } from './sheetRegistry'
import AgentSheetView from '../sheets/AgentSheetView'
import PrismManagerSheetView from '../sheets/PrismManagerSheetView'
import type { SheetRecord } from './sheetTypes'

interface SheetHostProps {
  activeSession: string | null
  onSelectSession: (id: string | null) => void
  onProfileEdit: () => void
  onSessionSettings: (id: string) => void
  sidebarCollapsed: boolean
  rightInset: number
  ccEditMode: boolean
}

export default function SheetHost(props: SheetHostProps) {
  const sheets = useStore(s => s.workspaceSheets.sheets)
  const activeSheetId = useStore(s => s.workspaceSheets.activeSheetId)
  const activeSheet = sheets.find(sheet => sheet.id === activeSheetId)

  if (!activeSheet) return <EmptySheetHost />
  return <SheetRenderer sheet={activeSheet} {...props} />
}

function SheetRenderer({ sheet, ...props }: { sheet: SheetRecord } & SheetHostProps) {
  const registry = SHEET_REGISTRY[sheet.kind]
  switch (registry.renderKey) {
    case 'agent-sheet':
      return <AgentSheetView sheet={sheet} {...props} />
    case 'prism-manager-sheet':
      return <PrismManagerSheetView />
    default:
      return <UnavailableSheet kind={sheet.kind} />
  }
}

function EmptySheetHost() {
  const openSheet = useStore(s => s.openSheet)
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
