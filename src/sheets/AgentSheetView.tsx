import { useEffect, useSyncExternalStore } from 'react'
import { useWorkspaceStore } from '../workspaceStore'
import { useReplayPostureStore } from '../components/chat/replayPostureStore'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'
import { deserializeAgentWorkspaceState } from '../workspace-sheets/agentWorkspaceState.ts'
import { useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'
import { getInterfaceModeRegistry } from '../plugin-runtime/runtimeServices.ts'
import { IsolatedPluginSurface } from '../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { BUILTIN_INTERFACE_MODES } from '../plugins/core/interfaceMode/builtinInterfaceModes.ts'
import AgentRendererSuiteWorkbench from './agent-workbench/AgentRendererSuiteWorkbench.tsx'
import { openResourceInFileSheet } from './file/fileSheetNavigation.ts'

const interfaceModeRegistry = getInterfaceModeRegistry()
const subscribeInterfaceModes = (listener: () => void) => interfaceModeRegistry.subscribe(listener)
const getInterfaceModeSnapshot = () => interfaceModeRegistry.getSnapshot()

/**
 * AgentSheetView — agent 主工作台（W1-03 侧栏上移后只留主区）。
 *
 * 侧栏已上移 SheetLayout（entry.sidebar → SheetSidebarSlot）；本组件只渲染主区
 * （Solid Renderer Suite + 右栏宿主），props 收敛为 { sheet, ctx }。
 *
 * W4-02（姿态二拍板）：历史回放以「只读姿态」直接进入本 sheet——Solid Workbench
 * 经现成 lifecycle 恢复消息，但输入宿主隐藏，改渲染「只读回放 · 点击继续」占位条；
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
  const modeSnapshot = useSyncExternalStore(
    subscribeInterfaceModes,
    getInterfaceModeSnapshot,
    getInterfaceModeSnapshot,
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
  // Chat is Solid-only. Even host-mode contributions fall back to the built-in
  // Solid suite, so the chat area never mounts the legacy React chat renderer.
  return <AgentRendererSuiteWorkbench
    sheet={sheet}
    ctx={ctx}
    modeId={mode.id}
    defaultSuiteId="builtin.solid"
    workspaceMode={workspaceMode}
    isReplay={isReplay}
  />
}
