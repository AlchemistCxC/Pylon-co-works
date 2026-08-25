import { useEffect, useSyncExternalStore } from 'react'
import ChatView from '../components/chat/ChatView'
import ControlCenter from '../components/ControlCenter'
import PetCompanion from '../components/PetCompanion'
import { useWorkspaceStore } from '../workspaceStore'
import { useReplayPostureStore } from '../components/chat/replayPostureStore'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'
import { deserializeAgentWorkspaceState } from '../workspace-sheets/agentWorkspaceState.ts'
import { useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'
import ModernAgentWorkbench from '../renderers/modern-workbench/ModernAgentWorkbench.tsx'
import { getInterfaceModeRegistry } from '../plugin-runtime/runtimeServices.ts'
import { IsolatedPluginSurface } from '../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { BUILTIN_INTERFACE_MODES } from '../plugins/core/interfaceMode/builtinInterfaceModes.ts'
import AgentRendererSuiteWorkbench from './agent-workbench/AgentRendererSuiteWorkbench.tsx'
import { openFileLinkFromEvent, openResourceInFileSheet } from './file/fileSheetNavigation.ts'

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
export default function AgentSheetView({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  // W2-11：showPet 消费点切 workspaceStore（W1-01 迁出主题，防换主题/toggle 双真值）
  const showPet = useWorkspaceStore(s => s.showPet)
  const postureSession = useReplayPostureStore(s => s.sessionId)
  // 姿态只对进入时的会话生效（非 null 且匹配 activeSession）
  const isReplay = ctx.activeSession !== null && postureSession === ctx.activeSession
  const workspaceMode = deserializeAgentWorkspaceState(sheet.state).sidebarMode
  const interfaceMode = useInterfaceModeStore(state => state.interfaceMode)
  const modeRegistry = getInterfaceModeRegistry()
  const modeSnapshot = useSyncExternalStore(
    listener => modeRegistry.subscribe(listener),
    () => modeRegistry.getSnapshot(),
    () => modeRegistry.getSnapshot(),
  )
  const mode = modeSnapshot.entries.find(entry => entry.value.id === interfaceMode)?.value
    ?? BUILTIN_INTERFACE_MODES.find(entry => entry.id === interfaceMode)
    ?? BUILTIN_INTERFACE_MODES.find(entry => entry.id === 'modern-gui')!
  useEffect(() => {
    if (postureSession !== null && postureSession !== ctx.activeSession) {
      useReplayPostureStore.getState().clear()
    }
  }, [postureSession, ctx.activeSession])
  if (mode.workbench.renderKind === 'isolated-surface') {
    return <IsolatedPluginSurface
      surfaceId={mode.workbench.surfaceId}
      className="main interface-mode-workbench-surface"
      input={{
        modeId: mode.id,
        sheet: { id: sheet.id, kind: sheet.kind, title: sheet.title, agentId: sheet.agentId },
        activeSessionId: ctx.activeSession,
        sessionSource: ctx.activeSession ? ctx.sessionSource(ctx.activeSession) : undefined,
        workspaceMode,
        showPet,
        isReplay,
      }}
      onEvent={(event, detail) => {
        if (event === 'workbench:continue-replay') useReplayPostureStore.getState().clear()
        else if (event === 'workbench:select-session' && typeof detail === 'string') ctx.selectSession(detail)
        else if (event === 'workbench:open-profile') ctx.openProfileEdit()
        else if (event === 'workbench:open-session-settings' && typeof detail === 'string') ctx.openSessionSettings(detail)
        else if ((event === 'workbench:open-resource' || event === 'workbench:reveal-resource') && ctx.activeSession) {
          openResourceInFileSheet(ctx.activeSession, detail)
        }
        else if (event === 'workbench:open-sheet' && detail && typeof detail === 'object') {
          const input = detail as { kind?: unknown, title?: unknown, agentId?: unknown }
          if (typeof input.kind === 'string' && typeof input.title === 'string') {
            ctx.openSheet({
              kind: input.kind,
              title: input.title,
              ...(typeof input.agentId === 'string' ? { agentId: input.agentId } : {}),
            })
          }
        }
      }}
    />
  }
  if (mode.workbench.renderKind === 'renderer-suite') {
    return <AgentRendererSuiteWorkbench
      sheet={sheet}
      ctx={ctx}
      modeId={mode.id}
      defaultSuiteId={mode.workbench.defaultSuiteId}
      workspaceMode={workspaceMode}
      isReplay={isReplay}
    />
  }
  if (mode.workbench.renderKind === 'host' && mode.workbench.renderer === 'modern') {
    return <ModernAgentWorkbench
      sheet={sheet}
      ctx={ctx}
      workspaceMode={workspaceMode}
      showPet={showPet}
      isReplay={isReplay}
      onContinueReplay={() => useReplayPostureStore.getState().clear()}
      onOpenFileLink={event => { openFileLinkFromEvent(event, ctx.activeSession) }}
    />
  }
  return (
    <div className="main" data-pylon-workbench="terminal-like" onClickCapture={event => { openFileLinkFromEvent(event, ctx.activeSession) }}>
      <div className={`main-body ${ctx.ccEditMode ? 'blur-bg' : ''}`} style={{
        // 右栏已是 .layout 的 flex sibling，主区宽度天然扣除右栏；此处不得再次预留，
        // 否则首次启动时中控输入栏会被重复挤压。
        '--right-panel-inset': '0px',
      } as React.CSSProperties}>
        <ChatView
          sessionId={ctx.activeSession}
          workspaceKind="agent"
          workspaceMode={workspaceMode}
          agentId={sheet.agentId}
          onSelectSession={ctx.selectSession}
          sidebarCollapsed={ctx.sidebarCollapsed}
          onExpandSidebar={() => useWorkspaceStore.getState().setSidebarCollapsed(false)}
        />
        {/* 无会话（品牌空态）时不显示中控与宠物 */}
        {ctx.activeSession !== null && (
          <>
            {showPet && !isReplay && <PetCompanion rightInset={0} />}
            {isReplay ? (
              <button type="button" className="replay-continue-bar" role="status" onClick={() => useReplayPostureStore.getState().clear()}>
                <span className="replay-continue-hint">只读回放 · 会话已加载</span>
                <span className="replay-continue-cta">点击继续此会话</span>
              </button>
            ) : (
              <ControlCenter sessionId={ctx.activeSession} />
            )}
          </>
        )}
      </div>
      {ctx.ccEditMode && <div className="cc-edit-overlay" />}
    </div>
  )
}
