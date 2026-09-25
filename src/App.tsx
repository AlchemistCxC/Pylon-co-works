import { useState, useEffect, lazy, Suspense, useRef, useSyncExternalStore } from 'react'
import SheetLayout from './workspace-sheets/SheetLayout'
import TacticalScene from './sheets/TacticalScene'
import WorkspaceTitlebar from './workspace-sheets/WorkspaceTitlebar'
import { useStore } from './store'
import { flushIdentityBackend, useIdentityStore } from './domains/identity/identityStore'
import { useRuntimeStore } from './runtimeStore'
import { useWorkspaceStore } from './workspaceStore'
import { IS_TAURI, isBrowserMockRuntime } from './infrastructure/tauri/env'
import { useShallow } from 'zustand/react/shallow'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { tauriInvokeTransport } from './infrastructure/acp/tauriTransport.ts'
import { loadWindowSize, persistWindowSize } from './windowSizePersistence'
import { reportRuntimeError, resolveRuntimeErrors } from './runtimeError'
import { sheetHasLeftColumn } from './workspace-sheets/sheetSidebarState.ts'
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
import { getCanonicalEventFeed } from './infrastructure/events/canonicalEventFeed.ts'
import { runRollupTrimBeforeClose } from './infrastructure/events/rollupTrim.ts'
import { createPermissionController, getPermissionController, registerPermissionController } from './infrastructure/acp/permissionController'
import { createInteractionRejectionController } from './infrastructure/acp/interactionRejectionController.ts'
import { startApplicationBootstrap } from './app/bootstrap/applicationBootstrapRun'
import { hydrateIdentityAndWorkspace, consumeLegacyProfilePayload } from './app/bootstrap/hydrateIdentityAndWorkspace'
import { useHydrationStore } from './app/bootstrap/hydrationState'
import { useModalOverlayVeil } from './app/modalOverlayStore'
import { startupMark, reportStartupTiming } from './app/startupTiming'
import PermissionDialog from './components/PermissionDialog'
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
  getShellRecipeRegistry,
} from './plugin-runtime/runtimeServices.ts'
import { projectFontContributions } from './infrastructure/fonts/fontProjection.ts'
import { getWorkspaceRegistrySnapshot, subscribeWorkspaceRegistry } from './workspace-sheets/workspaceRegistry.ts'
import { activateInterfaceMode, ensureInterfaceModeProfile, interfaceModeQuickTarget, resolveShellRecipe } from './application/transactions/activateInterfaceMode.ts'
import { useInterfaceModeStore } from './domains/interface/interfaceModeStore.ts'
import { selectContextPanels } from './plugin-runtime/context-panel/contextPanelSelection.ts'
import { usePresentationPreferenceStore } from './domains/presentation/presentationPreferenceStore.ts'
import { IsolatedPluginSurface } from './plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { BUILTIN_INTERFACE_MODES } from './plugins/core/interfaceMode/builtinInterfaceModes.ts'
import { drainPersistentStateBeforeClose } from './app/lifecycle/drainPersistentStateBeforeClose.ts'
import { useRightRailStore } from './rightRailStore.ts'
import { normalizeApprovalMode, persistApprovalMode, readPersistedApprovalMode } from './domains/permission/approvalMode.ts'
import { openOrFocusSettingsSheet } from './sheets/settingsSheetNavigation.ts'

// 非首屏 Dialog/Sheet 懒加载：ProfileEditor/SessionSettings 与 Prism Sheet 按需分包
// #154 阶段 4：Settings 不再是覆盖层 Dialog——迁入 sheet 体系（settingsSheetNavigation）。
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
const shellRecipeRegistry = getShellRecipeRegistry()
const subscribeShellRecipes = (listener: () => void) => shellRecipeRegistry.subscribe(listener)
const getShellRecipeSnapshot = () => shellRecipeRegistry.getSnapshot()

// Bootstrap notification identity is application-scoped and intentionally
// stable across retries/remounts. Keeping it outside the effect avoids
// allocating a new matcher while a run is in flight.
const bootstrapScope = { kind: 'app' as const, id: 'bootstrap' }
const bootstrapKey = (action: string) => `bootstrap:${action}`
const approvalModeScope = { kind: 'app' as const, id: 'approval-mode' }
const approvalModeKey = (action: string) => `app:approval-mode:${action}`

function LazyDialogFallback() {
  return (
    <div className="sheet-empty-host">
      <div className="sheet-empty-kicker">LOADING</div>
      <p>加载模块…</p>
    </div>
  )
}

// FE-AUD-008：typed client 收口 command literal（注入真实 transport）
const agentClient = createAgentClient({ invoke: tauriInvokeTransport })
const runtimeClient = createRuntimeClient({ invoke: tauriInvokeTransport })
// 窗口控制句柄：非 Tauri 环境（浏览器预览）降级为无操作 stub。模块级单例，避免每 render 重建。
const appWindowSingleton = (() => { try { return getCurrentWindow() } catch { return { minimize() {}, isFullscreen() { return Promise.resolve(false) }, setFullscreen(_v: boolean) { return Promise.resolve() }, destroy() {} } } })()

// 非 Tauri（浏览器预览）时 @tauri-apps/api 的 listen/invoke 会 reject，统一守卫

export default function App() {
  const interfaceMode = useInterfaceModeStore(state => state.interfaceMode)
  const hydrationStatus = useHydrationStore(state => state.status)
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
  // Shell Recipe（ADR-0003）：激活期已硬校验引用；此处订阅仅保证插件热换后
  // 数据属性跟随 registry 快照更新。解析兜底 classic，瞬态不崩壳。
  useSyncExternalStore(
    subscribeShellRecipes,
    getShellRecipeSnapshot,
    getShellRecipeSnapshot,
  )
  const shellRecipe = resolveShellRecipe(interfaceModeContribution)
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
  const showSidebar = useStore(s => s.showSidebar !== false)
  // #154：左列是否存在以「注册表真的提供 sidebar 组件」为准，而不是只看 sidebarMode。
  // 后者会让「声明 'sheet' 但把左栏画在自己内容区里」的 Sheet 也空占一条标题栏轨道，
  // 那条轨道自画的边框由此与左列自己的边框错开（浏览器 Sheet 实测错开 84px）。
  // 主题级 showSidebar 一并计入，否则标题栏会为被主题隐藏的左栏保留轨道。
  const sidebarEnabled = sheetHasLeftColumn(activeSheet) && showSidebar
  const rightPanelEnabled = activeSheet
    ? selectContextPanels(contextPanelSnapshot.entries, {
      workspaceKind: activeSheet.kind,
      sheetId: activeSheet.id,
      activeSessionId: activeSession,
    }).length > 0
    : false
  const agents = useIdentityStore(s => s.agents)
  // #326：空串 = 没有 Agent（零 Agent 首跑）。不再回落硬编码 'peri'——那会凭空造出一个
  // 不存在的 Agent（sheet 聚焦、权限切片、会话归属都按它算）。
  const activeAgent = useIdentityStore(s => s.activeAgent)
  const prevActiveAgentRef = useRef<string>(activeAgent)

  useEffect(() => {
    const clearActiveSession = () => setActiveSession(null)
    window.addEventListener('pylon:agent-switched', clearActiveSession)
    return () => window.removeEventListener('pylon:agent-switched', clearActiveSession)
  }, [])

  // 施工文档 §5.3：ErrorCenter/Overview 的恢复按钮经窗口事件打开现有 Settings /
  // Runtime Sheet，不新建导航 store。
  // #154 阶段 4：open-settings 落点从覆盖层改为设置 sheet（幂等：已开则 patch 导航态并聚焦）。
  useEffect(() => {
    const openSettings = (event: Event) => {
      const detail = (event as CustomEvent<{ domain?: string; section?: string; agentId?: string }>).detail ?? {}
      openOrFocusSettingsSheet(detail)
    }
    const openRuntime = () => useWorkspaceStore.getState().openSheet({ kind: 'runtime', title: 'Runtime' })
    window.addEventListener('pylon:open-settings', openSettings)
    window.addEventListener('pylon:open-runtime-sheet', openRuntime)
    return () => {
      window.removeEventListener('pylon:open-settings', openSettings)
      window.removeEventListener('pylon:open-runtime-sheet', openRuntime)
    }
  }, [])

  // FE-AUD-005：单一 bootstrap 事务（阶段 2）——hydrate domains → agents → prune → listener
  const [bootstrapRetry, setBootstrapRetry] = useState(0)
  useEffect(() => {
    // #269：App chunk 已加载并进入 bootstrap 事务（打点在前一帧的 shell_mounted
    // 与本点之间即 chunk 拉取耗时）。
    startupMark('app_bootstrap_start')
    const bootstrapRun = startApplicationBootstrap({
      isTauri: IS_TAURI && !isBrowserMockRuntime(),
      // I14-W6：bootstrap 等待 identity hydration（Tauri 后端读回 / browser 本地）
      // 完成后，再恢复 workspace 与 Agent（ISSUE-14 目标行为 #5）。
      hydrateDomains: async () => {
        await hydrateIdentityAndWorkspace(consumeLegacyProfilePayload())
        startupMark('hydrated')
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
        // #98：冷挂载——agent_status 快照恢复 pending permission 卡（幂等去重）。
        getPermissionController()?.seedFromSnapshot(payload)
      },
      registerListeners: async () => {
        const unlisten = await listen<AgentStatusPayload>('pylon:agent-status', event => {
          const activeAgent = useIdentityStore.getState().activeAgent
          const status = normalizeAgentStatus(event.payload, activeAgent)
          useRuntimeStore.getState().setAgentStatus(status.agentId || status.agent || activeAgent, status)
          getPermissionController()?.seedFromSnapshot(event.payload)
        })
        // P51：后端 session/load 复活失败而新建会话时广播（Pylon 重启后首次发送）。
        // 回写新 periId，使下一次发送/重启能继续复活这条新会话而不是再新建。
        const unlistenRecreated = await listen<{ source: string; periId: string }>('pylon:session-recreated', event => {
          const { source, periId } = event.payload
          const session = useIdentityStore.getState().sessions.find(item => item.source === source)
          if (session && session.periId !== periId) {
            useIdentityStore.getState().setSessionPeriId(session.id, periId)
          }
        })
        return () => { unlisten(); unlistenRecreated() }
      },
      reportError: (action, error) => reportRuntimeError(action, error, undefined, {
        key: bootstrapKey(action),
        scope: bootstrapScope,
        source: 'application.bootstrap',
        recoveryAction: {
          label: '重试启动',
          run: () => setBootstrapRetry(value => value + 1),
        },
      }),
      resolveError: action => resolveRuntimeErrors({ key: bootstrapKey(action), scope: bootstrapScope }),
      // #269：ready 即启动事务终点——打点并一次性上报前后端启动时间线。
      setStatus: (status, error) => {
        if (status === 'ready') {
          startupMark('ready')
          reportStartupTiming()
        }
        useHydrationStore.getState().setStatus(status, error)
      },
    })
    return bootstrapRun.dispose
  }, [bootstrapRetry])

  // 全局审批模式不是会话事实：启动时先恢复本地最近一次成功设置，
  // 再同步当前 Tauri runtime，避免进程重启后 UI 与 permission dispatcher 分叉。
  useEffect(() => {
    if (!IS_TAURI || isBrowserMockRuntime()) return
    let disposed = false
    const reportApprovalError = (action: string, error: unknown) => reportRuntimeError(action, error, undefined, {
      key: approvalModeKey(action),
      scope: approvalModeScope,
      source: 'permission.approval-mode',
    })
    const persisted = readPersistedApprovalMode()
    if (persisted) {
      useRuntimeStore.getState().setApprovalMode(persisted)
      void runtimeClient.setApprovalMode(persisted).then(() => {
        if (!disposed) resolveRuntimeErrors({ key: approvalModeKey('恢复权限模式'), scope: approvalModeScope })
      }, error => {
        if (!disposed) reportApprovalError('恢复权限模式', error)
      })
      return () => { disposed = true }
    }
    void runtimeClient.getApprovalMode().then(value => {
      if (disposed || typeof value !== 'string') return
      const mode = normalizeApprovalMode(value)
      if (!mode) return
      useRuntimeStore.getState().setApprovalMode(mode)
      persistApprovalMode(mode)
      resolveRuntimeErrors({ key: approvalModeKey('读取权限模式'), scope: approvalModeScope })
    }).catch(error => {
      if (!disposed) reportApprovalError('读取权限模式', error)
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
      getCurrentAgentId: () => useIdentityStore.getState().activeAgent,
      listen: (event, handler) => listen(event, handler),
      invoke: tauriInvokeTransport,
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
    if (saved) win.setSize(new PhysicalSize(saved.width, saved.height)).catch(error => console.warn('恢复上次窗口尺寸失败', error))
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
    if (hydrationStatus !== 'ready') return
    if (demoSeededRef.current) return
    const demoParams = new URLSearchParams(window.location.search)
    void import('./app/bootstrap/browserDemoBootstrap.ts').then(({ runBrowserDemoSeed }) => {
      if (demoSeededRef.current) return
      runBrowserDemoSeed(setActiveSession, {
        withPermission: demoParams.get('demo-permission') === '1',
        scenario: demoParams.get('demo-scenario') === 'standard' ? 'standard' : 'visual',
        reset: demoParams.get('demo-reset') === '1',
      })
      demoSeededRef.current = true
      resolveRuntimeErrors({ key: 'app:browser-demo-bootstrap' })
    }).catch(error => {
      if (!demoSeededRef.current) reportRuntimeError('加载浏览器演示数据', error, undefined, {
        key: 'app:browser-demo-bootstrap',
        scope: { kind: 'app', id: 'browser-demo' },
        source: 'app.browser-demo',
      })
    })
    return undefined
  }, [hydrationStatus])

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
    { layout: { sidebarCollapsed, sidebarWidth, sidebarEnabled } },
  )

  // Portal 与 body::before 都在 `.app` 外：完整投影全局 Skin，避免二级菜单、
  // 新建 Sheet 与设置 Dialog 退回默认主题。
  useEffect(() => {
    return projectSkinDocumentRoot(document.documentElement, document.body, resolved)
  }, [resolved])

  const appWindow = appWindowSingleton
  const drainBeforeClose = async () => {
    await drainPersistentStateBeforeClose({
      flushCanonical: () => getCanonicalEventFeed().flushAsync(),
      flushIdentity: flushIdentityBackend,
    })
    // #81 L3：前端 pending 已清空（kernel 单写者）→ 安全窗口内运行裁剪迁移
    // （可暂停/续跑；超时不阻塞关窗；trim_rolledup 策略关闭时后端只报告）。
    await runRollupTrimBeforeClose()
  }
  const closeWindowWithFlush = async () => {
    try {
      await drainBeforeClose()
    } catch (error) {
      reportRuntimeError('关闭前持久化失败，窗口已保持打开', error, undefined, {
        key: 'app:close-persistence', scope: { kind: 'app', id: 'lifecycle' }, source: 'app.lifecycle',
      })
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
        reportRuntimeError('关闭前持久化失败，窗口已保持打开', error, undefined, {
          key: 'app:close-persistence', scope: { kind: 'app', id: 'lifecycle' }, source: 'app.lifecycle',
        })
        return
      }
      await win.destroy()
    }).then(fn => { unlisten = fn }).catch(error => console.error('注册窗口关闭 flush 失败', error))
    return () => { unlisten?.() }
  }, [])
  const profilesOpen = showProfileEdit
  // #309：原生子视图（浏览器 WebView2 子窗口）在原生层位于 DOM 之上，覆盖层盖不住它。
  // 模态覆盖层打开期间让原生子视图暂时隐藏（页面继续运行），否则覆盖层上的按钮被
  // 原生页面吃掉点击；关闭后由消费方恢复可见。
  useModalOverlayVeil('sheet-launcher', showSheetLauncher)
  useModalOverlayVeil('profile-editor', profilesOpen)
  useModalOverlayVeil('session-settings', sessionSettingsId !== null)

  return (
    <div className="app" ref={appSkinRef} {...resolved.dataAttributes} data-interface-mode={interfaceMode} data-presentation-profile={presentationProfileId} data-shell-sidebar-side={shellRecipe.sidebarSide} data-shell-context-side={shellRecipe.contextPanelSide}>
      {interfaceMode === 'tactical-blue' && <TacticalScene />}
      <WorkspaceTitlebar
        sheets={workspaceSheets.sheets}
        activeSheetId={workspaceSheets.activeSheetId}
        activeAgent={activeAgent}
        activeSheetKind={activeSheet?.kind}
        activeSessionId={activeSession}
        sidebarCollapsed={sidebarCollapsed}
        sidebarEnabled={sidebarEnabled}
        rightPanelEnabled={rightPanelEnabled}
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
        onToggleRightPanel={() => useRightRailStore.getState().setCollapsed(!useRightRailStore.getState().collapsed)}
        // 齿轮菜单的设置域项是唯一设置入口：幂等开/聚焦（ADR-0013）；关闭走页签（#195）。
        onOpenSettingsDomain={domain => { openOrFocusSettingsSheet({ domain }) }}
        interfaceMode={interfaceMode}
        chromeStyle={interfaceModeContribution.chromeStyle}
        quickSwitchLabel={quickInterfaceMode?.label}
        onToggleInterfaceMode={quickInterfaceMode ? () => activateInterfaceMode(quickInterfaceMode.id) : undefined}
        onMinimize={() => appWindow.minimize()}
        onToggleFullscreen={() => appWindow.isFullscreen().then(fullscreen => appWindow.setFullscreen(!fullscreen)).catch(error => console.error('全屏切换失败', error))}
        onCloseWindow={() => void closeWindowWithFlush()}
      />
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
            onOpenSettings={() => openOrFocusSettingsSheet()}
            onOpenProfiles={() => setShowProfileEdit(true)}
          />
        )}
      </Suspense>

      <ErrorCenter />
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
        {/* #154 阶段 4：设置覆盖层挂载点退役——设置以 settings sheet 常驻 sheet 体系。 */}
        {profilesOpen && <ProfileEditor onClose={() => setShowProfileEdit(false)} />}
        {sessionSettingsId && <SessionSettings sessionId={sessionSettingsId} open={!!sessionSettingsId} onClose={() => setSessionSettingsId(null)} onDeleted={() => setActiveSession(null)} />}
      </Suspense>
      {/* 权限请求弹窗：store 驱动（无 active 请求返回 null），App 单例挂载不随 sheet 卸载 */}
      <PermissionDialog />
    </div>
  )
}
