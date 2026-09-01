import { useState, useEffect, lazy, Suspense, useRef, useSyncExternalStore } from 'react'
import SheetLayout from './workspace-sheets/SheetLayout'
import WorkspaceTitlebar from './workspace-sheets/WorkspaceTitlebar'
import { useStore } from './store'
import { flushIdentityBackend, useIdentityStore } from './identityStore'
import { useRuntimeStore } from './runtimeStore'
import { useWorkspaceStore } from './workspaceStore'
import { IS_TAURI, isBrowserMockRuntime } from './infrastructure/tauri/env'
import { useShallow } from 'zustand/react/shallow'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { invoke } from '@tauri-apps/api/core'
import { loadWindowSize, persistWindowSize } from './windowSizePersistence'
import { reportRuntimeError } from './runtimeError'
import { resolveSheetRender } from './workspace-sheets/sheetRegistry.tsx'
import {
  closeOtherWorkspaces,
  closeRightWorkspaces,
  closeWorkspace,
} from './workspace-sheets/workspaceController.ts'
import { useSkinSurface } from './infrastructure/skin/useSkinSurface'
import { projectSkinDocumentRoot } from './infrastructure/skin/skinProjection'
import { getSkinRuntime, pickThemeBaseline } from './infrastructure/skin/skinRuntimeServices'
import { listen } from '@tauri-apps/api/event'
import { normalizeAgentStatus, type AgentStatusPayload } from './components/settings/agentTypes'
import { createAgentClient } from './infrastructure/acp/agentClient'
import { createRuntimeClient } from './infrastructure/tauri/runtimeClient'
import { getChatController } from './components/chat/chatEventController'
import { createPermissionController, registerPermissionController } from './infrastructure/acp/permissionController'
import { createInteractionRejectionController } from './infrastructure/acp/interactionRejectionController.ts'
import { startApplicationBootstrap } from './app/bootstrap/applicationBootstrapRun'
import { hydrateIdentityAndWorkspace, consumeLegacyProfilePayload } from './app/bootstrap/hydrateIdentityAndWorkspace'
import { useHydrationStore } from './app/bootstrap/hydrationState'
import PermissionDialog from './components/PermissionDialog'
import InteractionRejectionNotice from './components/InteractionRejectionNotice'
import ErrorCenter from './components/ErrorCenter'
import SessionOwnerRecoveryDialog from './components/SessionOwnerRecoveryDialog'
import {
  applyAgentInstancesThroughPort,
  applyToolDictionaryThroughPort,
} from './app/ports/productContributionPorts.ts'
import {
  getContextPanelRegistry,
  getFontContributionRegistry,
  getInterfaceModeRegistry,
  getPluginServiceRegistry,
} from './plugin-runtime/runtimeServices.ts'
import { projectFontContributions } from './infrastructure/fonts/fontProjection.ts'
import { getWorkspaceRegistrySnapshot, subscribeWorkspaceRegistry } from './workspace-sheets/workspaceRegistry.ts'
import { activateInterfaceMode, ensureInterfaceModeProfile, interfaceModeQuickTarget } from './application/transactions/activateInterfaceMode.ts'
import { useInterfaceModeStore } from './domains/interface/interfaceModeStore.ts'
import { selectAvailableContextPanels } from './plugin-runtime/context-panel/contextPanelSelection.ts'
import { usePresentationPreferenceStore } from './domains/presentation/presentationPreferenceStore.ts'
import { IsolatedPluginSurface } from './plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { BUILTIN_INTERFACE_MODES } from './plugins/core/interfaceMode/builtinInterfaceModes.ts'
import { drainPersistentStateBeforeClose } from './app/lifecycle/drainPersistentStateBeforeClose.ts'
import { useRightRailStore } from './rightRailStore.ts'
import { normalizeApprovalMode, persistApprovalMode, readPersistedApprovalMode } from './domains/permission/approvalMode.ts'

// 非首屏 Dialog/Sheet 懒加载：Settings/ProfileEditor/SessionSettings 与 Prism Sheet 按需分包
const Settings = lazy(() => import('./components/Settings'))
const ProfileEditor = lazy(() => import('./components/ProfileEditor'))
const SessionSettings = lazy(() => import('./components/SessionSettings'))
const SheetLauncher = lazy(() => import('./workspace-sheets/SheetLauncher'))

// Runtime registries are process singletons.  Stable adapters keep
// useSyncExternalStore subscriptions intact across unrelated App renders
// (streaming, window resize, and dialog state changes).
const contextPanelRegistry = getContextPanelRegistry()
const subscribeContextPanels = (listener: () => void) => contextPanelRegistry.subscribe(listener)
const getContextPanelSnapshot = () => contextPanelRegistry.getSnapshot()
const fontContributionRegistry = getFontContributionRegistry()
const subscribeFontContributions = (listener: () => void) => fontContributionRegistry.subscribe(listener)
const getFontContributionSnapshot = () => fontContributionRegistry.getSnapshot()
const interfaceModeRegistry = getInterfaceModeRegistry()
const subscribeInterfaceModes = (listener: () => void) => interfaceModeRegistry.subscribe(listener)
const getInterfaceModeSnapshot = () => interfaceModeRegistry.getSnapshot()

function LazyDialogFallback() {
  return (
    <div className="sheet-empty-host">
      <div className="sheet-empty-kicker">LOADING</div>
      <p>加载模块…</p>
    </div>
  )
}

// FE-AUD-008：typed client 收口 command literal（注入真实 transport）
const agentClient = createAgentClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
const runtimeClient = createRuntimeClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
// 窗口控制句柄：非 Tauri 环境（浏览器预览）降级为无操作 stub。模块级单例，避免每 render 重建。
const appWindowSingleton = (() => { try { return getCurrentWindow() } catch { return { minimize() {}, isFullscreen() { return Promise.resolve(false) }, setFullscreen(_v: boolean) { return Promise.resolve() }, destroy() {} } } })()

// 非 Tauri（浏览器预览）时 @tauri-apps/api 的 listen/invoke 会 reject，统一守卫

export default function App() {
  const interfaceMode = useInterfaceModeStore(state => state.interfaceMode)
  const presentationProfileId = usePresentationPreferenceStore(state => state.activeProfileId)
  useSyncExternalStore(subscribeWorkspaceRegistry, getWorkspaceRegistrySnapshot, getWorkspaceRegistrySnapshot)
  const contextPanelSnapshot = useSyncExternalStore(
    subscribeContextPanels,
    getContextPanelSnapshot,
    getContextPanelSnapshot,
  )
  const fontSnapshot = useSyncExternalStore(
    subscribeFontContributions,
    getFontContributionSnapshot,
    getFontContributionSnapshot,
  )
  useEffect(() => projectFontContributions(document.documentElement, fontSnapshot.entries), [fontSnapshot])
  const interfaceModeSnapshot = useSyncExternalStore(
    subscribeInterfaceModes,
    getInterfaceModeSnapshot,
    getInterfaceModeSnapshot,
  )
  const interfaceModeContribution = interfaceModeSnapshot.entries.find(entry => entry.value.id === interfaceMode)?.value
    ?? BUILTIN_INTERFACE_MODES.find(entry => entry.id === 'modern-gui')!
  const quickInterfaceMode = interfaceModeQuickTarget(interfaceMode)
  useEffect(() => {
    document.documentElement.dataset.interfaceMode = interfaceMode
    document.body.dataset.interfaceMode = interfaceMode
    return () => {
      delete document.documentElement.dataset.interfaceMode
      delete document.body.dataset.interfaceMode
    }
  }, [interfaceMode])
  useEffect(() => { ensureInterfaceModeProfile() }, [interfaceMode, interfaceModeSnapshot])
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsIntent, setSettingsIntent] = useState<{ domain?: string; section?: string; agentId?: string } | null>(null)
  // W2-12：右栏折叠迁 workspaceStore（右栏按 sheet 声明挂载），旧 RightPanel 退役
  const [showProfileEdit, setShowProfileEdit] = useState(false)
  const [sessionSettingsId, setSessionSettingsId] = useState<string | null>(null)
  const [showSheetLauncher, setShowSheetLauncher] = useState(false)
  // W1-03（F2-B）：折叠/宽度状态迁入 workspaceStore（预设不覆盖布局），App 只读
  const sidebarWidth = useRightRailStore(s => s.leftRailWidth)
  const workspaceSheets = useWorkspaceStore(s => s.workspaceSheets)
  // active Sheet 的左栏模式同时决定折叠按钮能力与 TitleBar 左侧轨道宽度。
  const activeSheet = workspaceSheets.sheets.find(sheet => sheet.id === workspaceSheets.activeSheetId)
  const sidebarCollapsed = useRightRailStore(s => s.leftRailCollapsed)
  const activeSidebarMode = activeSheet ? resolveSheetRender(activeSheet.kind)?.sidebarMode : undefined
  // workspace / sheet 两类左栏都消费 workspaceStore.sidebarCollapsed，因此所有带左栏的
  // Sheet 共用 TitleBar 最左端入口；none 才禁用。
  const sidebarEnabled = activeSidebarMode === 'workspace' || activeSidebarMode === 'sheet'
  const rightPanelEnabled = activeSheet
    ? selectAvailableContextPanels(contextPanelSnapshot.entries, {
      workspaceKind: activeSheet.kind,
      sheetId: activeSheet.id,
      activeSessionId: activeSession,
    }).length > 0
    : false
  // 所有带左栏的 Sheet 使用同一几何契约：展开宽度与左栏一致，折叠后统一为 42px。
  const sidebarExpandedTrack = sidebarEnabled
  const agents = useIdentityStore(s => s.agents)
  const activeAgent = useIdentityStore(s => s.activeAgent) || 'peri'
  const prevActiveAgentRef = useRef<string>(activeAgent)

  useEffect(() => {
    const clearActiveSession = () => setActiveSession(null)
    window.addEventListener('pylon:agent-switched', clearActiveSession)
    return () => window.removeEventListener('pylon:agent-switched', clearActiveSession)
  }, [])

  // 施工文档 §5.3：ErrorCenter/Overview 的恢复按钮经窗口事件打开现有 Settings /
  // Runtime Sheet，不新建导航 store。
  useEffect(() => {
    const openSettings = (event: Event) => {
      const detail = (event as CustomEvent<{ domain?: string; section?: string; agentId?: string }>).detail ?? {}
      setSettingsIntent(detail)
      setShowSettings(true)
    }
    const openRuntime = () => useWorkspaceStore.getState().openSheet({ kind: 'runtime', title: 'Runtime' })
    window.addEventListener('pylon:open-settings', openSettings)
    window.addEventListener('pylon:open-runtime-sheet', openRuntime)
    return () => {
      window.removeEventListener('pylon:open-settings', openSettings)
      window.removeEventListener('pylon:open-runtime-sheet', openRuntime)
    }
  }, [])

  // G0：Chat controller 应用级宿主——listener 随应用生命周期（卸载才 dispose）
  useEffect(() => () => {
    getChatController()?.dispose()
  }, [])

  // FE-AUD-005：单一 bootstrap 事务（阶段 2）——hydrate domains → agents → prune → listener
  const [bootstrapRetry, setBootstrapRetry] = useState(0)
  useEffect(() => {
    const bootstrapRun = startApplicationBootstrap({
      isTauri: IS_TAURI && !isBrowserMockRuntime(),
      // I14-W6：bootstrap 等待 identity hydration（Tauri 后端读回 / browser 本地）
      // 完成后，再恢复 workspace 与 Agent（ISSUE-14 目标行为 #5）。
      hydrateDomains: async () => {
        await hydrateIdentityAndWorkspace(consumeLegacyProfilePayload())
      },
      fetchAgents: () => agentClient.listAgents(),
      applyAgents: list => {
        applyAgentInstancesThroughPort(getPluginServiceRegistry(), list)
        useIdentityStore.getState().setAgents(list)
      },
      fetchToolDictionary: () => agentClient.listToolDictionary(),
      applyToolDictionary: payload => applyToolDictionaryThroughPort(getPluginServiceRegistry(), payload),
      // 冷启动 Agent 状态快照（方案 A）：listener 注册前先查询一次初始状态，
      // 避免 titlebar 状态灯/发送能力 gate 因初始状态缺失而全灰/禁用。
      fetchAgentStatus: () => agentClient.agentStatus(),
      applyAgentStatus: payload => {
        const activeAgent = useIdentityStore.getState().activeAgent
        const status = normalizeAgentStatus(payload as AgentStatusPayload, activeAgent)
        useRuntimeStore.getState().setAgentStatus(status.agentId || status.agent || activeAgent, status)
      },
      registerListeners: async () => {
        const unlisten = await listen<AgentStatusPayload>('pylon:agent-status', event => {
          const activeAgent = useIdentityStore.getState().activeAgent
          const status = normalizeAgentStatus(event.payload, activeAgent)
          useRuntimeStore.getState().setAgentStatus(status.agentId || status.agent || activeAgent, status)
        })
        return () => { unlisten() }
      },
      reportError: (action, error) => reportRuntimeError(action, error),
      setStatus: (status, error) => useHydrationStore.getState().setStatus(status, error),
    })
    return bootstrapRun.dispose
  }, [bootstrapRetry])

  // 全局审批模式不是会话事实：启动时先恢复本地最近一次成功设置，
  // 再同步当前 Tauri runtime，避免进程重启后 UI 与 permission dispatcher 分叉。
  useEffect(() => {
    if (!IS_TAURI || isBrowserMockRuntime()) return
    let disposed = false
    const persisted = readPersistedApprovalMode()
    if (persisted) {
      useRuntimeStore.getState().setApprovalMode(persisted)
      void runtimeClient.setApprovalMode(persisted).catch(error => {
        if (!disposed) reportRuntimeError('恢复权限模式', error)
      })
      return () => { disposed = true }
    }
    void runtimeClient.getApprovalMode().then(value => {
      if (disposed || typeof value !== 'string') return
      const mode = normalizeApprovalMode(value)
      if (!mode) return
      useRuntimeStore.getState().setApprovalMode(mode)
      persistApprovalMode(mode)
    }).catch(error => {
      if (!disposed) reportRuntimeError('读取权限模式', error)
    })
    return () => { disposed = true }
  }, [])

  // 仅在 activeAgent 切换时聚焦该 agent 的 sheet；普通 sheet 导航（打开 Prism/工具 sheet、
  // 点击其他 tab）不受影响。用 ref 对比避免 workspaceSheets 每次新引用触发重复聚焦。
  useEffect(() => {
    if (prevActiveAgentRef.current === activeAgent) return
    prevActiveAgentRef.current = activeAgent
    const agentSheet = workspaceSheets.sheets.find(sheet => sheet.kind === 'agent' && sheet.agentId === activeAgent)
    if (agentSheet) useWorkspaceStore.getState().focusSheet(agentSheet.id)
  }, [activeAgent, workspaceSheets])

  // 权限请求 controller：只挂生命周期（listen → store 纯 reducer；approve invoke），不内嵌业务分支
  useEffect(() => {
    if (!IS_TAURI) return
    const controller = createPermissionController({
      dispatch: action => useRuntimeStore.getState().setPermission(action),
      getState: () => useRuntimeStore.getState().permission,
      // P1-1：controller 只作用在当前 agent 的权限切片
      getCurrentAgentId: () => useIdentityStore.getState().activeAgent || 'peri',
      listen: (event, handler) => listen(event, handler),
      invoke: (cmd, args) => invoke(cmd, args),
    })
    registerPermissionController(controller)
    return () => {
      registerPermissionController(null)
      void controller.dispose()
    }
  }, [])

  // Unsupported/malformed ACP interactions have their own transport and notice;
  // they must not be inserted into the permission reducer as actionable requests.
  useEffect(() => {
    if (!IS_TAURI) return
    const controller = createInteractionRejectionController({
      listen: (event, handler) => listen(event, handler),
    })
    return () => { void controller.dispose() }
  }, [])

  // 窗口尺寸记忆：启动恢复上次尺寸，resize 防抖持久化（纯前端，不依赖后端）
  useEffect(() => {
    if (!IS_TAURI) return
    const win = getCurrentWindow()
    const saved = loadWindowSize(localStorage)
    if (saved) win.setSize(new PhysicalSize(saved.width, saved.height)).catch(() => {})
    let timer: number | null = null
    let disposed = false
    const unlisten = win.onResized(({ payload }) => {
      if (disposed) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        persistWindowSize(localStorage, { width: payload.width, height: payload.height })
      }, 400)
    })
    return () => {
      disposed = true
      if (timer !== null) window.clearTimeout(timer)
      unlisten.then(stop => stop())
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setShowSheetLauncher(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 浏览器模式静态演示全景（用户直派，非施工项）：每次启动补 agents/状态灯（非持久化），
  // 仅首次种会话/sheets。声明在所有现有 effect 之后（SheetLayout 子 effect 先跑）；
  // 幂等=seedDemo 内部（sessions 空才种会话）+ seededRef（StrictMode 双跑）。
  const demoSeededRef = useRef(false)
  useEffect(() => {
    // Keep the browser/demo adapter out of production bundles.  Tauri
    // production must not merely skip the seed at runtime; the dynamic
    // import itself is development/mock-only.
    if (!import.meta.env.DEV) return
    if (IS_TAURI && !isBrowserMockRuntime()) return
    if (demoSeededRef.current) return
    demoSeededRef.current = true
    const demoParams = new URLSearchParams(window.location.search)
    void import('./app/bootstrap/browserDemoBootstrap.ts').then(({ runBrowserDemoSeed }) => {
      runBrowserDemoSeed(setActiveSession, {
        withPermission: demoParams.get('demo-permission') === '1',
        scenario: demoParams.get('demo-scenario') === 'standard' ? 'standard' : import.meta.env.DEV ? 'visual' : 'standard',
        reset: demoParams.get('demo-reset') === '1',
      })
    }).catch(error => reportRuntimeError('加载浏览器演示数据', error))
  }, [])

  const themeBaseline = useStore(useShallow(s => pickThemeBaseline(s as unknown as Record<string, unknown>)))
  const skinRuntime = getSkinRuntime()

  // Skin Runtime 全局基线 = 当前 Theme Store；启用 Runtime 后现有主题外观不变。
  useEffect(() => {
    skinRuntime.setGlobalBaseline(themeBaseline)
  }, [skinRuntime, themeBaseline])

  // 根 surface 投影：CSS variables / data-skin-* / scoped css 统一由 resolved skin 派生。
  const { ref: appSkinRef, resolved } = useSkinSurface<HTMLDivElement>(
    'app',
    { scope: 'global' },
    {},
    { layout: { sidebarCollapsed, sidebarWidth, sidebarEnabled, sidebarExpandedTrack } },
  )

  // Portal 与 body::before 都在 `.app` 外：完整投影全局 Skin，避免二级菜单、
  // 新建 Sheet 与设置 Dialog 退回默认主题。
  useEffect(() => {
    return projectSkinDocumentRoot(document.documentElement, document.body, resolved)
  }, [resolved])

  const appWindow = appWindowSingleton
  const drainBeforeClose = () => drainPersistentStateBeforeClose({
    flushCanonical: () => getChatController()?.flushCanonicalEventsAsync() ?? Promise.resolve(),
    flushIdentity: flushIdentityBackend,
  })
  const closeWindowWithFlush = async () => {
    try {
      await drainBeforeClose()
    } catch (error) {
      reportRuntimeError('关闭前持久化失败，窗口已保持打开', error)
      return
    }
    await appWindow.destroy()
  }
  useEffect(() => {
    if (!IS_TAURI) return
    const win = getCurrentWindow()
    let unlisten: (() => void) | undefined
    void win.onCloseRequested(async event => {
      event.preventDefault()
      try {
        await drainBeforeClose()
      } catch (error) {
        reportRuntimeError('关闭前持久化失败，窗口已保持打开', error)
        return
      }
      await win.destroy()
    }).then(fn => { unlisten = fn }).catch(error => console.error('注册窗口关闭 flush 失败', error))
    return () => { unlisten?.() }
  }, [])
  // FE-AUD-005：bootstrap 降级提示（报告阶段 2.4：Agent 列表失败可重试，不清空本地工作区）
  const hydrationStatus = useHydrationStore(state => state.status)
  const hydrationError = useHydrationStore(state => state.error)
  const profilesOpen = showProfileEdit
  const settingsOpen = showSettings

  return (
    <div className="app" ref={appSkinRef} {...resolved.dataAttributes} data-interface-mode={interfaceMode} data-presentation-profile={presentationProfileId}>
      <WorkspaceTitlebar
        sheets={workspaceSheets.sheets}
        activeSheetId={workspaceSheets.activeSheetId}
        activeAgent={activeAgent}
        activeSheetKind={activeSheet?.kind}
        activeSessionId={activeSession}
        sidebarCollapsed={sidebarCollapsed}
        sidebarEnabled={sidebarEnabled}
        sidebarExpandedTrack={sidebarExpandedTrack}
        rightPanelEnabled={rightPanelEnabled}
        canReopenSheet={workspaceSheets.recentlyClosed.length > 0}
        onToggleSidebar={() => useRightRailStore.getState().setLeftRailCollapsed(!sidebarCollapsed)}
        onFocusSheet={id => useWorkspaceStore.getState().focusSheet(id)}
        onCloseSheet={id => { void closeWorkspace(id) }}
        menuActions={{
          onTogglePin: id => useWorkspaceStore.getState().toggleSheetPin(id),
          onClose: id => { void closeWorkspace(id) },
          onCloseOthers: id => { void closeOtherWorkspaces(id) },
          onCloseRight: id => { void closeRightWorkspaces(id) },
          onReopen: () => useWorkspaceStore.getState().reopenSheet(),
        }}
        onOpenSheet={() => setShowSheetLauncher(true)}
        onReopenSheet={() => useWorkspaceStore.getState().reopenSheet()}
        onToggleRightPanel={() => useRightRailStore.getState().setCollapsed(!useRightRailStore.getState().collapsed)}
        onToggleSettings={() => setShowSettings(value => !value)}
        settingsOpen={settingsOpen}
        interfaceMode={interfaceMode}
        chromeStyle={interfaceModeContribution.chromeStyle}
        quickSwitchLabel={quickInterfaceMode?.label}
        onToggleInterfaceMode={quickInterfaceMode ? () => activateInterfaceMode(quickInterfaceMode.id) : undefined}
        onMinimize={() => appWindow.minimize()}
        onToggleFullscreen={() => appWindow.isFullscreen().then(fullscreen => appWindow.setFullscreen(!fullscreen)).catch(error => console.error('全屏切换失败', error))}
        onCloseWindow={() => void closeWindowWithFlush()}
      />
      {hydrationStatus === 'degraded' && (
        <div className="workspace-persist-warning" role="alert">
          启动降级：{hydrationError ?? '读取 Agent 列表失败'}
          <button type="button" className="template-apply" onClick={() => setBootstrapRetry(retry => retry + 1)}>重试</button>
        </div>
      )}
      {interfaceModeContribution.shellSurface?.placement === 'before-workspace' && (
        <IsolatedPluginSurface
          surfaceId={interfaceModeContribution.shellSurface.surfaceId}
          className="interface-mode-shell-surface interface-mode-shell-before-workspace"
          input={{ modeId: interfaceModeContribution.id, activeSheetId: workspaceSheets.activeSheetId, activeAgent }}
        />
      )}
      <Suspense fallback={null}>
        {showSheetLauncher && (
          <SheetLauncher
            open={showSheetLauncher}
            agents={agents}
            sheets={workspaceSheets.sheets}
            onOpenChange={setShowSheetLauncher}
            onFocusSheet={id => useWorkspaceStore.getState().focusSheet(id)}
            onOpenSheet={(kind, title, agentId) => useWorkspaceStore.getState().openSheet({ kind, title, agentId })}
            onOpenSettings={() => setShowSettings(true)}
            onOpenProfiles={() => setShowProfileEdit(true)}
          />
        )}
      </Suspense>

      <ErrorCenter />
      <InteractionRejectionNotice />
      <SessionOwnerRecoveryDialog />

      {/* W1-03：布局段下移 SheetLayout（侧栏壳/主区/右栏壳 + profile 投影 effects） */}
      <SheetLayout
        activeSession={activeSession}
        onSelectSession={setActiveSession}
        onProfileEdit={() => setShowProfileEdit(true)}
        onSessionSettings={setSessionSettingsId}
      />
      {interfaceModeContribution.shellSurface?.placement === 'overlay' && (
        <IsolatedPluginSurface
          surfaceId={interfaceModeContribution.shellSurface.surfaceId}
          className="interface-mode-shell-surface interface-mode-shell-overlay"
          input={{ modeId: interfaceModeContribution.id, activeSheetId: workspaceSheets.activeSheetId, activeAgent }}
        />
      )}
      <Suspense fallback={<LazyDialogFallback />}>
        {settingsOpen && <Settings activeSessionId={activeSession} onClose={() => setShowSettings(false)} initialDomain={settingsIntent?.domain} initialSection={settingsIntent?.section} initialAgentId={settingsIntent?.agentId} />}

        {profilesOpen && <ProfileEditor onClose={() => setShowProfileEdit(false)} />}
        {sessionSettingsId && <SessionSettings sessionId={sessionSettingsId} open={!!sessionSettingsId} onClose={() => setSessionSettingsId(null)} onDeleted={() => setActiveSession(null)} />}
      </Suspense>
      {/* 权限请求弹窗：store 驱动（无 active 请求返回 null），App 单例挂载不随 sheet 卸载 */}
      <PermissionDialog />
    </div>
  )
}
