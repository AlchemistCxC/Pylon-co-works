import { Bot, CircleDot, SlidersHorizontal, Sparkles } from 'lucide-react'
import ChatView from '../../components/chat/ChatView.tsx'
import ControlCenter from '../../components/ControlCenter.tsx'
import PetCompanion from '../../components/PetCompanion.tsx'
import { useIdentityStore } from '../../identityStore.ts'
import { useRuntimeStore } from '../../runtimeStore.ts'
import { selectAgentStatus } from '../../components/settings/agentTypes.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'
import { useWorkspaceStore } from '../../workspaceStore.ts'

interface ModernAgentWorkbenchProps {
  sheet: SheetRecord
  ctx: SheetContext
  workspaceMode: 'work' | 'chat'
  showPet: boolean
  isReplay: boolean
  onContinueReplay(): void
  onOpenFileLink(event: React.MouseEvent<HTMLElement>): void
}

export default function ModernAgentWorkbench({ sheet, ctx, workspaceMode, showPet, isReplay, onContinueReplay, onOpenFileLink }: ModernAgentWorkbenchProps) {
  const sessions = useIdentityStore(state => state.sessions)
  const statuses = useRuntimeStore(state => state.agentStatuses)
  const session = sessions.find(candidate => candidate.id === ctx.activeSession)
  const status = selectAgentStatus(sheet.agentId ?? '', sheet.agentId ?? '', statuses)
  return (
    <div className="main modern-agent-workbench" data-pylon-workbench="modern-gui" onClickCapture={onOpenFileLink}>
      <header className="modern-workbench-header">
        <span className="modern-workbench-mark" aria-hidden="true"><Sparkles size={16} /></span>
        <span className="modern-workbench-heading">
          <small>AGENT WORKSPACE</small>
          <strong>{session?.name || sheet.title}</strong>
        </span>
        <span className="modern-workbench-agent"><Bot size={14} aria-hidden="true" />{sheet.title}</span>
        <span className={`modern-workbench-status status-${status.status}`}><CircleDot size={13} aria-hidden="true" />{status.status}</span>
        {ctx.activeSession && <button type="button" className="modern-workbench-action" onClick={() => ctx.openSessionSettings(ctx.activeSession!)} aria-label="打开会话设置" title="会话设置"><SlidersHorizontal size={16} aria-hidden="true" /></button>}
      </header>
      <div className={`main-body modern-workbench-body ${ctx.ccEditMode ? 'blur-bg' : ''}`} style={{ '--right-panel-inset': '0px' } as React.CSSProperties}>
        <div className="modern-conversation-canvas">
          <ChatView
            sessionId={ctx.activeSession}
            workspaceKind="agent"
            workspaceMode={workspaceMode}
            agentId={sheet.agentId}
            onSelectSession={ctx.selectSession}
            sidebarCollapsed={ctx.sidebarCollapsed}
            onExpandSidebar={() => useWorkspaceStore.getState().setSidebarCollapsed(false)}
          />
        </div>
        {ctx.activeSession !== null && (
          <>
            {showPet && !isReplay && <PetCompanion rightInset={0} />}
            {isReplay ? (
              <button type="button" className="replay-continue-bar modern-replay-continue" role="status" onClick={onContinueReplay}>
                <span className="replay-continue-hint">只读回放 · 会话已加载</span>
                <span className="replay-continue-cta">继续此会话</span>
              </button>
            ) : (
              <div className="modern-command-dock"><ControlCenter sessionId={ctx.activeSession} /></div>
            )}
          </>
        )}
      </div>
      {ctx.ccEditMode && <div className="cc-edit-overlay" />}
    </div>
  )
}
