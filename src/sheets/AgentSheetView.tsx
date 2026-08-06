import { useEffect } from 'react'
import ChatView from '../components/chat/ChatView'
import ControlCenter from '../components/ControlCenter'
import PetCompanion from '../components/PetCompanion'
import { useWorkspaceStore } from '../workspaceStore'
import { useReplayPostureStore } from '../components/chat/replayPostureStore'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'

/**
 * AgentSheetView — agent 主工作台（W1-03 侧栏上移后只留主区）。
 *
 * 侧栏已上移 SheetLayout（entry.sidebar → SheetSidebarSlot）；本组件只渲染主区
 * （ChatView + PetCompanion + ControlCenter），props 收敛为 { sheet, ctx }。
 *
 * W4-02（姿态二拍板）：历史回放以「只读姿态」直接进入本 sheet——ChatView 照常挂载
 * （load_persisted_session 经现成 lifecycle 恢复消息，listener 先于 load 挂接），但
 * ControlCenter（InputBar/send/attach 宿主）隐藏，改渲染「只读回放 · 点击继续」占位条；
 * 点击 clear 姿态 → ControlCenter 出现 → 首次 send 即 live。姿态是一次性手势：
 * 离开该会话/关闭 sheet 即清除，防 tab 重开误回只读。
 */
export default function AgentSheetView({ ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  // W2-11：showPet 消费点切 workspaceStore（W1-01 迁出主题，防换主题/toggle 双真值）
  const showPet = useWorkspaceStore(s => s.showPet)
  const postureSession = useReplayPostureStore(s => s.sessionId)
  // 姿态只对进入时的会话生效（非 null 且匹配 activeSession）
  const isReplay = ctx.activeSession !== null && postureSession === ctx.activeSession
  useEffect(() => {
    if (postureSession !== null && postureSession !== ctx.activeSession) {
      useReplayPostureStore.getState().clear()
    }
  }, [postureSession, ctx.activeSession])
  return (
    <div className="main">
      <div className={`main-body ${ctx.ccEditMode ? 'blur-bg' : ''}`} style={{
        // 右栏已是 .layout 的 flex sibling，主区宽度天然扣除右栏；此处不得再次预留，
        // 否则首次启动时中控输入栏会被重复挤压。
        '--right-panel-inset': '0px',
      } as React.CSSProperties}>
        <ChatView sessionId={ctx.activeSession} />
        {showPet && !isReplay && <PetCompanion rightInset={0} />}
        {isReplay ? (
          <button type="button" className="replay-continue-bar" role="status" onClick={() => useReplayPostureStore.getState().clear()}>
            <span className="replay-continue-hint">只读回放 · 会话已加载</span>
            <span className="replay-continue-cta">点击继续此会话</span>
          </button>
        ) : (
          <ControlCenter sessionId={ctx.activeSession} />
        )}
      </div>
      {ctx.ccEditMode && <div className="cc-edit-overlay" />}
    </div>
  )
}
