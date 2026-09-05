import { open } from '@tauri-apps/plugin-dialog'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Session } from '../../identityStore.ts'
import { useIdentityStore } from '../../identityStore.ts'
import { RendererSuiteHost } from '../../host/renderer-suite/rendererSuiteHost.ts'
import { resolveRendererActivation } from '../../plugin-runtime/renderers/rendererActivationResolver.ts'
import type { RendererActivationSnapshot } from '../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import { getPluginSettingOptionsRegistry, getPresentationProfileRegistry, getRendererRegistry, getRendererSettingsStore } from '../../plugin-runtime/runtimeServices.ts'
import { resolveProductionRenderAppearance } from '../../plugin-runtime/renderers/productionRenderAppearance.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { createWorkbenchHostPort, type WorkbenchHostPort } from '../../renderers/solid-workbench/workbenchHostPort.ts'
import type { WorkbenchMountInput } from '../../renderers/solid-workbench/workbenchContracts.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'
import { createAgentWorkbenchSessionRuntime, workbenchSessionBindingKey } from './agentWorkbenchSession.ts'
import { useSessionLifecycle, type ChatSessionSetters } from '../../components/chat/useSessionLifecycle.ts'

export interface WorkbenchFatalFailure {
  readonly suiteId: string
  readonly pluginId?: string
  readonly phase: string
  readonly message: string
  readonly retained?: boolean
}

import { useWorkspaceStore } from '../../workspaceStore.ts'
import { toCanonicalOwnerKey } from '../../domains/events/eventSchema.ts'
import { resolveRendererSuiteFallback } from '../../host/renderer-suite/rendererSuiteFallbackPolicy.ts'
import { useWorkspaceEntityStore } from '../../workspaceEntityStore.ts'
import { publishActiveWorkbenchHostPort } from './activeWorkbenchHostPort.ts'
import { createAgentWorkbenchSession, discardAgentWorkbenchSession } from './agentWorkbenchSessionCreation.ts'
import { openFileLinkFromEvent, openResourceInFileSheet } from '../file/fileSheetNavigation.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../../runtimeError.ts'

export interface AgentRendererSuiteWorkbenchProps {
  sheet: SheetRecord
  ctx: SheetContext
  modeId: string
  defaultSuiteId: string
  workspaceMode: 'work' | 'chat'
  isReplay: boolean
}

const ownerKey = (session: Session | undefined) => session
  ? toCanonicalOwnerKey({ profileId: session.profileId, agentId: session.agentId, localSessionId: session.source })
  : null

const workspaceLabel = (workdir: string | undefined) => workdir
  ?.replace(/[\\/]+$/, '')
  .split(/[\\/]/)
  .filter(Boolean)
  .pop()

// Keep the mutable-ref read outside the effect cleanup so the hooks linter can
// verify the lifecycle contract without weakening the StrictMode deferral.
function isCurrentLifecycleToken(ref: { current: number }, token: number): boolean {
  return ref.current === token
}

const rendererRegistry = getRendererRegistry()
const subscribeRendererCatalog = (listener: () => void) => rendererRegistry.subscribe(listener)
const getRendererCatalogSnapshot = () => rendererRegistry.snapshot()

export default function AgentRendererSuiteWorkbench(props: AgentRendererSuiteWorkbenchProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const currentPropsRef = useRef(props)
  currentPropsRef.current = props
  const sessionRuntimeRef = useRef<ReturnType<typeof createAgentWorkbenchSessionRuntime> | null>(null)
  if (!sessionRuntimeRef.current) sessionRuntimeRef.current = createAgentWorkbenchSessionRuntime({
    commands: {
      createSession: request => {
        const current = currentPropsRef.current
        return createAgentWorkbenchSession(request, {
          agentId: current.sheet.agentId || useIdentityStore.getState().activeAgent,
          workspaceMode: current.workspaceMode,
          applySessionResponse: (sessionId, response) => sessionRuntimeRef.current?.applySessionResponse(response, sessionId),
        })
      },
      selectSession: id => currentPropsRef.current.ctx.selectSession(id),
      discardSession: discardAgentWorkbenchSession,
      async openResource(session, resource) {
        if (openResourceInFileSheet(session.id, resource)) return
        const uri = resource && typeof resource === 'object' && !Array.isArray(resource) && 'uri' in resource
          ? (resource as { uri?: unknown }).uri
          : undefined
        if (typeof uri === 'string' && /^(?:https?:|mailto:)/i.test(uri)) {
          window.open(uri, '_blank', 'noopener,noreferrer')
          return
        }
        throw new Error('resource_not_openable')
      },
      async revealResource(session, resource) {
        if (!openResourceInFileSheet(session.id, resource)) throw new Error('resource_not_revealable')
      },
    },
  })
  const sessionRuntime = sessionRuntimeRef.current
  const sessions = useIdentityStore(state => state.sessions)
  const workspaces = useWorkspaceEntityStore(state => state.workspaces)
  const isActiveSheet = useWorkspaceStore(state => state.workspaceSheets.activeSheetId === props.sheet.id)
  const session = sessions.find(item => item.id === props.ctx.activeSession)
  const workspace = session?.workspaceId ? workspaces.find(item => item.id === session.workspaceId) : undefined
  const activeProfileId = usePresentationPreferenceStore(state => state.activeProfileId)
  const selectedSuiteId = usePresentationPreferenceStore(state => state.rendererSuiteIdByMode[props.modeId])
  const rendererSettings = getRendererSettingsStore()
  const presentationProfiles = getPresentationProfileRegistry()
  const rendererSettingOptions = getPluginSettingOptionsRegistry()
  const catalog = useSyncExternalStore(subscribeRendererCatalog, getRendererCatalogSnapshot, getRendererCatalogSnapshot)
  const input = useMemo<WorkbenchMountInput>(() => Object.freeze({
    sheetId: props.sheet.id, sessionOwnerKey: ownerKey(session), sessionId: props.ctx.activeSession,
    workspaceMode: props.workspaceMode, replayReadonly: props.isReplay,
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    visibility: isActiveSheet ? 'active' : 'background', rightInset: props.ctx.rightInset, preview: false,
    presentationProfileId: activeProfileId,
    sessionLabel: session?.name,
    workspaceLabel: workspace?.name ?? workspaceLabel(session?.workdir),
    workspacePath: workspace?.rootPath ?? session?.workdir,
    availableWorkspaces: workspaces.map(item => ({ id: item.id, label: item.name, path: item.rootPath, lastActiveAt: item.lastActiveAt })),
  }), [props.sheet.id, props.ctx.activeSession, props.ctx.rightInset, props.workspaceMode, props.isReplay, session, workspace, workspaces, activeProfileId, isActiveSheet])
  const activation = useMemo(() => {
    try {
      return resolveRendererActivation(catalog, {
        userSelectedSuiteId: selectedSuiteId, modeDefaultSuiteId: props.defaultSuiteId,
        builtInSolidSuiteId: 'builtin.solid', documentSchema: 'workbench.v1', renderCatalogSchema: 1,
      })
    } catch { return undefined }
  }, [catalog, selectedSuiteId, props.defaultSuiteId])
  const activationKey = activation ? `${activation.suite.ownerRuntimeInstanceId}\u0000${activation.suite.value.id}\u0000${activation.revision}` : undefined
  const [activeSuiteId, setActiveSuiteId] = useState<string | undefined>(activation?.suite.value.id)
  const [failure, setFailure] = useState<WorkbenchFatalFailure | null>(null)
  const [fatal, setFatal] = useState(false)
  const hostRef = useRef<RendererSuiteHost | null>(null)
  const hostPortRef = useRef<WorkbenchHostPort | null>(null)
  const hostPortsRef = useRef<Map<string, WorkbenchHostPort>>(new Map())
  const hostListenerRef = useRef<(() => void) | null>(null)
  const activePortReleaseRef = useRef<(() => void) | null>(null)
  const inputRef = useRef(input)
  const targetActivationRef = useRef<RendererActivationSnapshot | undefined>(activation)
  const activeActivationRef = useRef<RendererActivationSnapshot | undefined>(undefined)
  const catalogRef = useRef(catalog)
  const activeActivationKeyRef = useRef<string | undefined>(undefined)
  const fallbackAttemptedRef = useRef<string | undefined>(undefined)
  const fallbackChainRef = useRef<Set<string>>(new Set())
  const automaticRetryRef = useRef<{ key?: string; attempts: number }>({ attempts: 0 })
  const automaticRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reportedRuntimeErrorRef = useRef<string | null>(null)
  const reportedRuntimeErrorKeyRef = useRef<string | null>(null)
  const reportedSuiteErrorKeyRef = useRef<string | null>(null)
  const retrySolidRef = useRef<() => void>(() => {})
  const visibilityRef = useRef(input.visibility)
  inputRef.current = input; catalogRef.current = catalog

  const headlessSetters = useMemo<ChatSessionSetters>(() => {
    const ignore = () => {}
    return { setMessages: ignore, setStreamingText: ignore, setStreamingThinking: ignore, setGenerating: ignore, setGenerationPhase: ignore, setSummary: ignore, setLastTokenAt: ignore }
  }, [])

  const sessionBindingKey = workbenchSessionBindingKey(session)
  useEffect(() => { void sessionRuntime.bind(session) }, [sessionRuntime, sessionBindingKey, session])
  // Recoverable bind/refresh failures are application notifications, not a
  // second banner in the chat surface. Publish one scoped entry and let the
  // central tray own its visibility and dismissal.
  useEffect(() => {
    const scope = session
      ? { kind: 'session' as const, id: session.id }
      : { kind: 'sheet' as const, id: props.sheet.id }
    const runtimeErrorKey = session
      ? `workbench-runtime:session:${session.id}`
      : `workbench-runtime:sheet:${props.sheet.id}`
    let disposed = false
    const previousRuntimeErrorKey = reportedRuntimeErrorKeyRef.current
    if (previousRuntimeErrorKey && previousRuntimeErrorKey !== runtimeErrorKey) {
      resolveRuntimeErrors({ key: previousRuntimeErrorKey, source: 'workbench.runtime' })
      reportedRuntimeErrorKeyRef.current = null
      reportedRuntimeErrorRef.current = null
    }
    const observe = () => {
      if (disposed) return
      const current = sessionRuntime.runtime.getSnapshot()
      const failed = (current.status === 'error' || current.status === 'degraded') && Boolean(current.error)
      if (!failed) {
        reportedRuntimeErrorRef.current = null
        reportedRuntimeErrorKeyRef.current = null
        resolveRuntimeErrors({ key: runtimeErrorKey, source: 'workbench.runtime' })
        return
      }
      const message = current.error!
      const signature = `${scope.kind}:${scope.id}:${message}`
      if (reportedRuntimeErrorRef.current === signature) return
      reportedRuntimeErrorRef.current = signature
      reportedRuntimeErrorKeyRef.current = runtimeErrorKey
      reportRuntimeError('工作台运行时', new Error(message), session?.agentId, {
        key: runtimeErrorKey,
        scope,
        source: 'workbench.runtime',
        recovery: { kind: 'open-runtime-log', sessionId: session?.id },
        recoveryAction: {
          label: '重试会话恢复',
          run: () => session ? sessionRuntime.bind(session) : undefined,
        },
      })
    }
    observe()
    const unsubscribe = sessionRuntime.runtime.subscribe(observe)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [props.sheet.id, session?.id, session?.agentId, sessionRuntime, session])
  useEffect(() => {
    const pickWorkspaceFolder = async () => {
      const selected = await open({ directory: true, multiple: false, title: '选择工作区文件夹' })
      if (typeof selected === 'string') window.dispatchEvent(new CustomEvent('pylon:workspace-folder-picked', { detail: { path: selected } }))
    }
    window.addEventListener('pylon:pick-workspace-folder', pickWorkspaceFolder)
    return () => window.removeEventListener('pylon:pick-workspace-folder', pickWorkspaceFolder)
  }, [])
  // React.StrictMode intentionally runs effect cleanup/setup once during the
  // initial dev mount. Destroying the mutable Workbench runtime in that probe
  // leaves the second (real) setup with a permanently inert runtime, which
  // presents as an empty chat even though the snapshot bridge loaded data.
  // Defer destruction by one microtask and cancel it when setup runs again;
  // genuine unmounts still destroy the runtime deterministically.
  const runtimeLifecycleToken = useRef(0)
  useEffect(() => {
    const token = ++runtimeLifecycleToken.current
    return () => {
      queueMicrotask(() => {
        if (isCurrentLifecycleToken(runtimeLifecycleToken, token)) sessionRuntime.destroy()
      })
    }
  }, [sessionRuntime])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !activation) { setFailure({ suiteId: 'unknown', phase: 'resolve', message: 'Renderer Suite catalog 为空' }); return }
    if (hostRef.current) {
      if (activeActivationKeyRef.current !== activationKey) {
        if (automaticRetryTimerRef.current) clearTimeout(automaticRetryTimerRef.current)
        automaticRetryTimerRef.current = null; automaticRetryRef.current = { attempts: 0 }
        activeActivationKeyRef.current = activationKey; targetActivationRef.current = activation; fallbackAttemptedRef.current = undefined; fallbackChainRef.current.clear()
        void hostRef.current.switchTo(activation)
      }
      return
    }
    const switchToFallback = (target: RendererActivationSnapshot | undefined, failedSuiteId: string) => {
      if (failedSuiteId === 'builtin.solid') return
      if (fallbackChainRef.current.has(failedSuiteId)) return
      const key = `${target?.suite.ownerRuntimeInstanceId ?? ''}\u0000${failedSuiteId}\u0000${target?.revision ?? 0}`
      fallbackAttemptedRef.current = key
      fallbackChainRef.current.add(failedSuiteId)
      try {
        const builtIn = resolveRendererActivation(catalogRef.current, { explicitSuiteId: 'builtin.solid', documentSchema: 'workbench.v1', renderCatalogSchema: 1 })
        const explicitId = target?.suite.value.fallbackSuiteId
        const explicitFallback = explicitId && !fallbackChainRef.current.has(explicitId)
          ? resolveRendererActivation(catalogRef.current, { explicitSuiteId: explicitId, documentSchema: 'workbench.v1', renderCatalogSchema: 1 })
          : undefined
        const fallback = resolveRendererSuiteFallback({ current: target, explicitFallback, builtInSolid: builtIn })
        if (!fallback || fallbackChainRef.current.has(fallback.suite.value.id)) { setFatal(true); return }
        targetActivationRef.current = fallback
        void hostRef.current?.switchTo(fallback)
      } catch { setFatal(true) }
    }
    const retryOrFallback = (target: RendererActivationSnapshot | undefined, next: WorkbenchFatalFailure) => {
      if (!target) { setFailure(next); setFatal(true); return }
      const key = `${target.suite.ownerRuntimeInstanceId}\u0000${target.suite.value.id}\u0000${target.revision}`
      if (automaticRetryRef.current.key !== key) automaticRetryRef.current = { key, attempts: 0 }
      if (automaticRetryRef.current.attempts < 2) {
        automaticRetryRef.current.attempts += 1
        const attempt = automaticRetryRef.current.attempts
        setFailure({ ...next, message: `${next.message}（自动重试 ${attempt}/2）` })
        automaticRetryTimerRef.current = setTimeout(() => {
          automaticRetryTimerRef.current = null
          if (targetActivationRef.current === target) void hostRef.current?.switchTo(target)
        }, 150 * (2 ** (attempt - 1)))
        return
      }
      setFailure(next)
      if (next.suiteId === 'builtin.solid') { setFatal(true); return }
      switchToFallback(target, next.suiteId)
    }
    const hostPortForSuite = (suiteId: string) => {
      const existing = hostPortsRef.current.get(suiteId)
      if (existing) return existing
      const created = createWorkbenchHostPort({
        runtime: sessionRuntime.runtime, appearance: sessionRuntime.appearance, sessionUi: sessionRuntime.sessionUi,
        commands: sessionRuntime.commands, suiteId, sheetId: props.sheet.id,
        sessionOwnerKey: inputRef.current.sessionOwnerKey, sessionId: inputRef.current.sessionId,
        capabilities: {
          prompt: true, cancel: true, attach: false, model: true, mode: true,
          sessionCreate: suiteId === 'builtin.solid', compact: false, sessionExport: false, sessionClear: false,
          sessionConfig: true,
          toolAction: false, interactionResponse: true, resourceOpen: true, resourceReveal: true,
          clipboardWrite: true, retry: false, recovery: false,
          appearanceEdit: suiteId === 'builtin.solid',
        },
        // Suite identity is fixed for the lifetime of this port. Session binding
        // may advance, but a preparing candidate cannot retarget the old instance.
        binding: () => ({ suiteId, sheetId: props.sheet.id, sessionOwnerKey: inputRef.current.sessionOwnerKey, sessionId: inputRef.current.sessionId }),
        renderAppearance: {
          resolve: (request, hostAppearance) => {
            const profileId = usePresentationPreferenceStore.getState().activeProfileId
            const profile = presentationProfiles.resolve(profileId)?.value
            return resolveProductionRenderAppearance({
              hostAppearance,
              catalog: catalogRef.current,
              settings: rendererSettings.getSnapshot(),
              profileKindTokens: profile?.kindTokens?.[request.kind],
              optionEntries: rendererSettingOptions.getSnapshot().entries,
              ...request,
            })
          },
          subscribe(listener) {
            const unsubscribers = [
              rendererSettings.subscribe(listener),
              presentationProfiles.subscribe(listener),
              rendererSettingOptions.subscribe(listener),
              usePresentationPreferenceStore.subscribe(listener),
            ]
            return () => unsubscribers.forEach(unsubscribe => unsubscribe())
          },
        },
        diagnostics: diagnostic => {
          if (diagnostic.recoverability !== 'retry' && diagnostic.recoverability !== 'fallback') return
          if (diagnostic.recoverability === 'retry') return
          const target = targetActivationRef.current
          const failedSuiteId = diagnostic.suiteId ?? suiteId
          const active = activeActivationRef.current
          const failedTarget = target?.suite.value.id === failedSuiteId
            ? target
            : active?.suite.value.id === failedSuiteId ? active : target
          retryOrFallback(failedTarget, {
            suiteId: failedSuiteId,
            pluginId: failedTarget?.suite.ownerPluginId,
            phase: diagnostic.phase ?? 'resolve',
            message: diagnostic.message,
          })
        },
      })
      hostPortsRef.current.set(suiteId, created)
      return created
    }
    const hostPort = hostPortForSuite(activation.suite.value.id)
    hostPortRef.current = hostPort
    const host = new RendererSuiteHost({
      container,
      hostPort,
      hostPortForActivation: candidate => hostPortForSuite(candidate.suite.value.id),
      input: inputRef.current,
    })
    hostRef.current = host; activeActivationKeyRef.current = activationKey; targetActivationRef.current = activation
    hostListenerRef.current = host.subscribe(state => {
      if (state.phase === 'active' && state.error) {
        const failedTarget = targetActivationRef.current
        const retained = activeActivationRef.current
        const failedKey = failedTarget
          ? `${failedTarget.suite.ownerRuntimeInstanceId}\u0000${failedTarget.suite.value.id}\u0000${failedTarget.revision}`
          : undefined
        const recoveringFatal = Boolean(failedKey
          && automaticRetryRef.current.key === failedKey
          && automaticRetryRef.current.attempts > 0)
        if (recoveringFatal) {
          retryOrFallback(failedTarget, {
            suiteId: failedTarget?.suite.value.id ?? state.previousSuiteId ?? 'unknown',
            pluginId: failedTarget?.suite.ownerPluginId,
            phase: 'switch',
            message: state.error instanceof Error ? state.error.message : String(state.error),
          })
          return
        }
        if (retained) targetActivationRef.current = retained
        const retainedSuiteId = state.suiteId ?? retained?.suite.value.id
        const retainedPort = retainedSuiteId ? hostPortsRef.current.get(retainedSuiteId) : undefined
        if (retainedPort && hostPortRef.current !== retainedPort) {
          activePortReleaseRef.current?.()
          activePortReleaseRef.current = publishActiveWorkbenchHostPort(props.sheet.id, retainedPort)
          hostPortRef.current = retainedPort
        }
        setActiveSuiteId(state.suiteId)
        setFailure({
          suiteId: failedTarget?.suite.value.id ?? state.previousSuiteId ?? 'unknown',
          pluginId: failedTarget?.suite.ownerPluginId,
          phase: 'switch',
          message: state.error instanceof Error ? state.error.message : String(state.error),
          retained: true,
        })
        return
      }
      if (state.phase === 'active') {
        activeActivationRef.current = targetActivationRef.current
        const activePort = state.suiteId ? hostPortsRef.current.get(state.suiteId) : undefined
        if (activePort && hostPortRef.current !== activePort) {
          activePortReleaseRef.current?.()
          activePortReleaseRef.current = publishActiveWorkbenchHostPort(props.sheet.id, activePort)
          hostPortRef.current = activePort
        } else if (activePort && !activePortReleaseRef.current) {
          activePortReleaseRef.current = publishActiveWorkbenchHostPort(props.sheet.id, activePort)
        }
        setActiveSuiteId(state.suiteId)
        setFatal(false)
        if (inputRef.current.visibility === 'background') host.pause()
        if (!fallbackAttemptedRef.current) setFailure(null)
        return
      }
      if (state.phase !== 'degraded' && !state.error) return
      const target = targetActivationRef.current
      const suiteId = target?.suite.value.id ?? state.previousSuiteId ?? state.suiteId ?? 'unknown'
      const next = { suiteId, pluginId: target?.suite.ownerPluginId, phase: state.phase === 'degraded' ? 'mount' : 'switch', message: state.error instanceof Error ? state.error.message : String(state.error ?? 'Renderer Suite 启动失败') }
      retryOrFallback(target, next)
    })
    void host.mount(activation)
  }, [activation, activationKey, presentationProfiles, props.sheet.id, rendererSettingOptions, rendererSettings, sessionRuntime])

  useEffect(() => () => {
    const host = hostRef.current
    if (automaticRetryTimerRef.current) clearTimeout(automaticRetryTimerRef.current)
    automaticRetryTimerRef.current = null
    hostRef.current = null; hostPortRef.current = null; activeActivationKeyRef.current = undefined
    activePortReleaseRef.current?.(); activePortReleaseRef.current = null
    hostListenerRef.current?.(); hostListenerRef.current = null
    if (host) void host.destroy()
    for (const port of hostPortsRef.current.values()) port.diagnostics.destroy?.()
    hostPortsRef.current.clear()
  }, [])
  useEffect(() => {
    const host = hostRef.current
    host?.update(input)
    if (visibilityRef.current === input.visibility) return
    visibilityRef.current = input.visibility
    if (input.visibility === 'background') host?.pause()
    else host?.resume()
  }, [input])

  const retrySolid = () => {
    const host = hostRef.current
    if (!host) return
    try {
      const builtIn = resolveRendererActivation(catalogRef.current, { explicitSuiteId: 'builtin.solid', documentSchema: 'workbench.v1', renderCatalogSchema: 1 })
      if (automaticRetryTimerRef.current) clearTimeout(automaticRetryTimerRef.current)
      automaticRetryTimerRef.current = null; automaticRetryRef.current = { attempts: 0 }
      targetActivationRef.current = builtIn; fallbackAttemptedRef.current = undefined; fallbackChainRef.current.clear(); setFatal(false); setFailure(null)
      void host.switchTo(builtIn)
    } catch (error) {
      setFailure({ suiteId: 'builtin.solid', phase: 'resolve', message: error instanceof Error ? error.message : String(error) }); setFatal(true)
    }
  }
  retrySolidRef.current = retrySolid

  // A retained/fallback Suite is recoverable application state. Keep its
  // diagnostic in the central tray instead of rendering a second banner in
  // the chat surface; fatal fallback remains the explicit blocking UI below.
  useEffect(() => {
    const scope = session
      ? { kind: 'session' as const, id: session.id }
      : { kind: 'sheet' as const, id: props.sheet.id }
    const previousKey = reportedSuiteErrorKeyRef.current
    if (fatal || !failure) {
      if (previousKey) resolveRuntimeErrors({ key: previousKey })
      reportedSuiteErrorKeyRef.current = null
      return
    }
    const key = `renderer-suite:${props.sheet.id}:${session?.id ?? 'none'}:${failure.suiteId}:${failure.phase}`
    if (previousKey && previousKey !== key) resolveRuntimeErrors({ key: previousKey })
    if (previousKey === key) return
    reportedSuiteErrorKeyRef.current = key
    const message = `${failure.suiteId} / ${failure.phase} / ${failure.message}`
    reportRuntimeError('Renderer Suite 回退', new Error(message), session?.agentId, {
      key,
      scope,
      source: 'renderer-suite',
      recovery: { kind: 'open-runtime-log', sessionId: session?.id, suiteId: failure.suiteId },
      recoveryAction: { label: '重试 Solid', run: () => retrySolidRef.current() },
    })
  }, [failure, fatal, props.sheet.id, session, session?.id, session?.agentId])
  const openDiagnostics = () => window.dispatchEvent(new CustomEvent('pylon:open-runtime-sheet'))

  return <div className="main renderer-suite-workbench" data-renderer-suite-host="true" data-suite-id={activeSuiteId ?? activation?.suite.value.id}
    onClickCapture={event => { openFileLinkFromEvent(event, props.ctx.activeSession) }}>
    <div ref={containerRef} className="renderer-suite-workbench-mount" hidden={fatal} />
    {fatal && failure && <section className="renderer-suite-fatal-banner" role="alert"
      aria-label="Renderer suite fatal banner" data-suite-id={failure.suiteId} data-failure-phase={failure.phase}>
      <strong>渲染引擎失败</strong>
      <span>{failure.suiteId} · {failure.phase}</span>
      {failure.pluginId && <span>{failure.pluginId}</span>}
      <span>{failure.message}</span>
      <div className="renderer-suite-fatal-actions">
        <button type="button" onClick={retrySolid}>重试 Solid</button>
        <button type="button" onClick={openDiagnostics}>打开诊断</button>
      </div>
    </section>}
     {isActiveSheet && <ActiveAgentSessionLifecycle session={session} sessions={sessions} setters={headlessSetters}
      selectSession={props.ctx.selectSession} sessionRuntime={sessionRuntime} />}
  </div>
}

function ActiveAgentSessionLifecycle(props: {
  session: Session | undefined
  sessions: readonly Session[]
  setters: ChatSessionSetters
  selectSession(id: string | null): void
  sessionRuntime: ReturnType<typeof createAgentWorkbenchSessionRuntime>
}) {
  const lifecycle = useSessionLifecycle(props.session?.id ?? null, props.sessions, props.setters, props.selectSession)
  const sessionRef = useRef(props.session)
  sessionRef.current = props.session
  useEffect(() => {
    const session = sessionRef.current
    if (session && lifecycle.canonicalRefresh?.sessionId === session.id) {
      // bind() is intentionally idempotent for metadata-only Session updates.
      // Canonical replay can nevertheless discover a terminal tool event after
      // the initial bind, so explicitly refresh the same owner document here.
      void props.sessionRuntime.refresh(session)
    }
  }, [props.sessionRuntime, props.session?.id, lifecycle.canonicalRefresh])
  // useSessionLifecycle reports recovery failures with a session scope; the
  // application ErrorCenter is the single ordinary-error presentation.
  return null
}
