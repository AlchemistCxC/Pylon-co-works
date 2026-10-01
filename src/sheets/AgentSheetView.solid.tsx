import { createEffect, createMemo, Show } from 'solid-js'
import { createSolidMount } from '../host/solidBridge.solid'
import { createElement, type ReactElement } from 'react'
import { useReplayPostureStore } from '../domains/chat/replayPostureStore'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'
import { createZustandSignal } from '../host/solidStoreBridge.ts'
import { getAgentSidebarRegistry } from '../plugin-runtime/runtimeServices.ts'
import { normalizePageState, resolveOpenPage } from '../plugin-runtime/sidebar/sidebarBlockState.ts'
import type { AgentSidebarContribution } from '../plugin-runtime/sidebar/sidebarTypes.ts'
import { openResourceInFileSheet } from './file/fileSheetNavigation.ts'
import { createActiveInterfaceModeContribution, createRegistrySignal, ReactIslandHost } from './solidSheetSupport.solid.tsx'

// ---- React 岛（#515 迁移期：整页宿主/隔离表面/Renderer Suite 工作台仍是 React 面，
// 批7 前经岛渲染；类型图不触碰 React 组件文件，模块接口就地声明，与实体侧逐字段一致）。 ----

interface AgentSheetPageHostProps {
  page: AgentSidebarContribution
  ctx: SheetContext
  sheet: { id: string }
}

interface AgentSheetPageHostModule {
  default: (props: AgentSheetPageHostProps) => ReactElement
}

const pageHostModules = import.meta.glob<AgentSheetPageHostModule>('../components/sidebar/AgentSheetPageHost.tsx', { eager: true })
const AgentSheetPageHost = pageHostModules['../components/sidebar/AgentSheetPageHost.tsx']?.default
if (!AgentSheetPageHost) throw new Error('AgentSheetPageHost React 面未进入 Vite module graph')

interface IsolatedPluginSurfaceProps {
  surfaceId: string
  className?: string
  input?: unknown
  onEvent?: (event: string, detail: unknown) => void
}

interface IsolatedPluginSurfaceModule {
  IsolatedPluginSurface: (props: IsolatedPluginSurfaceProps) => ReactElement
}

const isolatedSurfaceModules = import.meta.glob<IsolatedPluginSurfaceModule>('../plugin-runtime/ui/IsolatedPluginSurface.tsx', { eager: true })
const IsolatedPluginSurface = isolatedSurfaceModules['../plugin-runtime/ui/IsolatedPluginSurface.tsx']?.IsolatedPluginSurface
if (!IsolatedPluginSurface) throw new Error('IsolatedPluginSurface React 面未进入 Vite module graph')

interface AgentRendererSuiteWorkbenchProps {
  sheet: SheetRecord
  ctx: SheetContext
  modeId: string
  defaultSuiteId: string
  isReplay: boolean
}

interface AgentRendererSuiteWorkbenchModule {
  default: (props: AgentRendererSuiteWorkbenchProps) => ReactElement
}

const workbenchModules = import.meta.glob<AgentRendererSuiteWorkbenchModule>('./agent-workbench/AgentRendererSuiteWorkbench.tsx', { eager: true })
const AgentRendererSuiteWorkbench = workbenchModules['./agent-workbench/AgentRendererSuiteWorkbench.tsx']?.default
if (!AgentRendererSuiteWorkbench) throw new Error('AgentRendererSuiteWorkbench React 面未进入 Vite module graph')

export interface AgentSheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

/**
 * AgentSheetView — agent 主工作台（W1-03 侧栏上移后只留主区）。
 *
 * 侧栏已上移 SheetLayout（entry.sidebar → SheetSidebarSlot）；本组件只渲染主区
 * （Solid Renderer Suite + 右栏宿主），props 收敛为 { sheet, ctx }。
 * #515：实体自 React 版逐行为同构迁移——姿态 store 经 createZustandSignal，整页解析
 * 与界面模式投影经注册表信号；三分支（整页宿主/隔离表面/Renderer Suite）的实体
 * 仍是 React 面，经 ReactIslandHost 岛挂载（批7 后随 React 面退役）。
 *
 * W4-02（姿态二拍板）：历史回放以「只读姿态」直接进入本 sheet——Solid Workbench
 * 经现成 lifecycle 恢复消息，但输入宿主隐藏，改渲染「只读回放 · 点击继续」占位条；
 * 点击 clear 姿态 → ControlCenter 出现 → 首次 send 即 live。姿态是一次性手势：
 * 离开该会话/关闭 sheet 即清除，防 tab 重开误回只读。
 */
export default function AgentSheetView(props: AgentSheetViewProps) {
  const postureSession = createZustandSignal(useReplayPostureStore, s => s.sessionId)
  const sidebarRegistry = getAgentSidebarRegistry()
  const sidebarSnapshot = createRegistrySignal(sidebarRegistry, () => sidebarRegistry.getSnapshot())
  // 左栏模块可以把自己的内容展开成「主区整页」——它**替换**聊天视图，但不开新 Sheet。
  // 这里只解析；解析在 memo 里（原实现刻意不在 hook 前早退，分支切换不改变订阅面）。
  const openPage = createMemo(() => resolveOpenPage(
    sidebarSnapshot().entries.map(entry => entry.value),
    normalizePageState(props.sheet.state),
  ))
  const contribution = createActiveInterfaceModeContribution()
  // 姿态只对进入时的会话生效（非 null 且匹配 activeSession）
  const isReplay = createMemo(() => props.ctx.activeSession !== null && postureSession() === props.ctx.activeSession)
  // 姿态是一次性手势：会话不匹配即清（原 useEffect [postureSession, ctx.activeSession]）。
  createEffect(() => {
    const posture = postureSession()
    const active = props.ctx.activeSession
    if (posture !== null && posture !== active) useReplayPostureStore.getState().clear()
  })

  const isolatedWorkbench = createMemo(() => {
    const workbench = contribution().workbench
    return workbench.renderKind === 'isolated-surface' ? workbench : null
  })
  const suiteRequest = createMemo(() => {
    const mode = contribution()
    return mode.workbench.renderKind === 'renderer-suite'
      ? mode.workbench.defaultSuiteId
      // Chat is Solid-only. Even host-mode contributions fall back to the built-in
      // Solid suite, so the chat area never mounts the legacy React chat renderer.
      : 'builtin.solid'
  })

  return (
    // 页面打开时聊天区整体不挂载（与切会话同一条路径：历史在返回时经 lifecycle 重读）。
    <Show when={openPage()} fallback={
      <Show when={isolatedWorkbench()} fallback={
        <ReactIslandHost element={() => {
          // 岛重渲触发：原 React 树父渲染即带新 ctx 重渲子树，等价粒度＝追踪 ctx 的
          // 可变字段（会话/右栏内缩）。ctx 是同一代理引用，结果稳定的 memo（如
          // isReplay）不会通知，必须直读字段。
          const activeSession = props.ctx.activeSession
          const rightInset = props.ctx.rightInset
          void activeSession
          void rightInset
          return createElement(AgentRendererSuiteWorkbench, {
            sheet: props.sheet,
            ctx: props.ctx,
            modeId: contribution().id,
            defaultSuiteId: suiteRequest(),
            isReplay: isReplay(),
          })
        }} />
      }>
        {workbench => (
          <ReactIslandHost element={() => createElement(IsolatedPluginSurface, {
            surfaceId: workbench().surfaceId,
            className: 'main interface-mode-workbench-surface',
            input: {
              modeId: contribution().id,
              sheet: { id: props.sheet.id, kind: props.sheet.kind, title: props.sheet.title, agentId: props.sheet.agentId },
              activeSessionId: props.ctx.activeSession,
              sessionSource: props.ctx.activeSession ? props.ctx.sessionSource(props.ctx.activeSession) : undefined,
              isReplay: isReplay(),
            },
            onEvent: (event, detail) => {
              if (event === 'workbench:continue-replay') useReplayPostureStore.getState().clear()
              else if (event === 'workbench:select-session' && typeof detail === 'string') props.ctx.selectSession(detail)
              else if (event === 'workbench:open-profile') props.ctx.openProfileEdit()
              else if (event === 'workbench:open-session-settings' && typeof detail === 'string') props.ctx.openSessionSettings(detail)
              else if ((event === 'workbench:open-resource' || event === 'workbench:reveal-resource') && props.ctx.activeSession) {
                openResourceInFileSheet(props.ctx.activeSession, detail)
              }
              else if (event === 'workbench:open-sheet' && detail && typeof detail === 'object') {
                const input = detail as { kind?: unknown, title?: unknown, agentId?: unknown }
                if (typeof input.kind === 'string' && typeof input.title === 'string') {
                  props.ctx.openSheet({
                    kind: input.kind,
                    title: input.title,
                    ...(typeof input.agentId === 'string' ? { agentId: input.agentId } : {}),
                  })
                }
              }
            },
          })} />
        )}
      </Show>
    }>
      {page => (
        <ReactIslandHost element={() => {
          // 岛重渲触发：会话切换要透传给整页宿主（原 React 父渲染语义）。
          void props.ctx.activeSession
          return createElement(AgentSheetPageHost, { page: page(), ctx: props.ctx, sheet: { id: props.sheet.id } })
        }} />
      )}
    </Show>
  )
}

/** React 薄桥（AgentSheetView.tsx）的挂载工厂：Solid JSX 只允许出现在本文件。 */
export const mountAgentSheetView = createSolidMount(AgentSheetView)
