import Sidebar from '../components/Sidebar'
import ChatView from '../components/chat/ChatView'
import ControlCenter from '../components/ControlCenter'
import PetCompanion from '../components/PetCompanion'
import type { SheetRecord } from '../workspace-sheets/sheetTypes'

interface AgentSheetViewProps {
  sheet: SheetRecord
  activeSession: string | null
  onSelectSession: (id: string | null) => void
  onProfileEdit: () => void
  onSessionSettings: (id: string) => void
  sidebarCollapsed: boolean
  rightInset: number
  ccEditMode: boolean
}

export default function AgentSheetView({
  activeSession,
  onSelectSession,
  onProfileEdit,
  onSessionSettings,
  sidebarCollapsed,
  rightInset,
  ccEditMode,
}: AgentSheetViewProps) {
  return (
    <>
      <Sidebar
        activeSession={activeSession}
        onSelectSession={onSelectSession}
        onProfileEdit={onProfileEdit}
        onSessionSettings={onSessionSettings}
        collapsed={sidebarCollapsed}
      />
      <div className="main">
        <div className={`main-body ${ccEditMode ? 'blur-bg' : ''}`} style={{
          '--right-panel-inset': `${rightInset}px`,
        } as React.CSSProperties}>
          <ChatView sessionId={activeSession} />
          <PetCompanion rightInset={rightInset} />
          <ControlCenter sessionId={activeSession} />
        </div>
        {ccEditMode && <div className="cc-edit-overlay" />}
      </div>
    </>
  )
}
