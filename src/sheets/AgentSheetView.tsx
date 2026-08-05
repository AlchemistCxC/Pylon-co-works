import ChatView from '../components/chat/ChatView'
import ControlCenter from '../components/ControlCenter'
import PetCompanion from '../components/PetCompanion'
import { useStore } from '../store'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'

/**
 * AgentSheetView — agent 主工作台（W1-03 侧栏上移后只留主区）。
 *
 * 侧栏已上移 SheetLayout（entry.sidebar → SheetSidebarSlot）；本组件只渲染主区
 * （ChatView + PetCompanion + ControlCenter），props 收敛为 { sheet, ctx }。
 */
export default function AgentSheetView({ ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const showPet = useStore(s => s.showPet !== false)
  return (
    <div className="main">
      <div className={`main-body ${ctx.ccEditMode ? 'blur-bg' : ''}`} style={{
        '--right-panel-inset': `${ctx.rightInset}px`,
      } as React.CSSProperties}>
        <ChatView sessionId={ctx.activeSession} />
        {showPet && <PetCompanion rightInset={ctx.rightInset} />}
        <ControlCenter sessionId={ctx.activeSession} />
      </div>
      {ctx.ccEditMode && <div className="cc-edit-overlay" />}
    </div>
  )
}
