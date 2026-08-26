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
import { createAgentWorkbenchSessionRuntime } from './agentWorkbenchSession.ts'
import { useSessionLifecycle, type ChatSessionSetters } from '../../components/chat/useSessionLifecycle.ts'
import ReactWorkbenchFatalFallback, { type WorkbenchFatalFailure } from './ReactWorkbenchFatalFallback.tsx'
import type { ImageContentPart } from '../../domains/workbench/content/contentPartSchema.ts'
import { useWorkspaceStore } from '../../workspaceStore.ts'
import { toCanonicalOwnerKey } from '../../domains/events/eventSchema.ts'
import { resolveRendererSuiteFallback } from '../../host/renderer-suite/rendererSuiteFallbackPolicy.ts'
import { useWorkspaceEntityStore } from '../../workspaceEntityStore.ts'
import { publishActiveWorkbenchHostPort } from './activeWorkbenchHostPort.ts'
import { createAgentWorkbenchSession, discardAgentWorkbenchSession } from './agentWorkbenchSessionCreation.ts'
import { openFileLinkFromEvent, openResourceInFileSheet } from '../file/fileSheetNavigation.ts'

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
  const registry = getRendererRegistry()
  const rendererSettings = getRendererSettingsStore()
  const presentationProfiles = getPresentationProfileRegistry()
  const rendererSettingOptions = getPluginSettingOptionsRegistry()
  const catalog = useSyncExternalStore(listener => registry.subscribe(listener), () => registry.snapshot(), () => registry.snapshot())
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
  const visibilityRef = useRef(input.visibility)
  inputRef.current = input; catalogRef.current = catalog

  const headlessSetters = useMemo<ChatSessionSetters>(() => {
    const ignore = () => {}
    return { setMessages: ignore, setStreamingText: ignore, setStreamingThinking: ignore, setGenerating: ignore, setGenerationPhase: ignore, setSummary: ignore, setLastTokenAt: ignore }
  }, [])

  useEffect(() => { void sessionRuntime.bind(session) }, [sessionRuntime, session])
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
        if (runtimeLifecycleToken.current === token) sessionRuntime.destroy()
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
  const selectSuite = () => window.dispatchEvent(new CustomEvent('pylon:open-settings', { detail: { domain: 'renderer', section: 'suite' } }))
  const openDiagnostics = () => window.dispatchEvent(new CustomEvent('pylon:open-runtime-sheet'))
  const openFallbackMedia = (part: ImageContentPart) => {
    const host = hostPortRef.current
    if (!host || !input.sessionId || !host.capabilities.has('resourceOpen')) return
    const target = part.sourceKind === 'path' ? { path: part.source } : { uri: part.source }
    void host.commands.openResource(input.sessionId, target)
  }
  const downloadFallbackMedia = (part: ImageContentPart) => {
    const host = hostPortRef.current
    if (!host || !input.sessionId || !host.capabilities.has('resourceOpen')) return
    void host.commands.openResource(input.sessionId, { ...part, disposition: 'download' })
  }
  const openFallbackInteractionUrl = (url: string) => {
    const host = hostPortRef.current
    if (!host || !input.sessionId || !host.capabilities.has('resourceOpen')) return
    void host.commands.openResource(input.sessionId, { uri: url })
  }
  const copyFallbackInteractionUrl = (url: string) => {
    const host = hostPortRef.current
    if (!host || !input.sessionId || !host.capabilities.has('clipboardWrite')) return
    void host.commands.copy(input.sessionId, url)
  }
  const retryFallbackMessage = () => {
    const host = hostPortRef.current
    if (!host || !input.sessionId || !host.capabilities.has('retry')) return
    void host.commands.retry(input.sessionId)
  }
  const recoverFallbackSession = (strategy: 'reload-plugin' | 'reimport') => {
    const host = hostPortRef.current
    if (!host || !input.sessionId || !host.capabilities.has('recovery')) return
    void host.commands.recover(input.sessionId, strategy)
  }
  const respondFallbackInteraction = (interactionId: string, response: unknown, options?: { expectedRevision?: number }) => {
    const host = hostPortRef.current
    if (!host || !input.sessionId || !host.capabilities.has('interactionResponse')) return
    return host.commands.respondInteraction(input.sessionId, interactionId, response, options)
  }

  return <div className="main renderer-suite-workbench" data-renderer-suite-host="true" data-suite-id={activeSuiteId ?? activation?.suite.value.id}
    onClickCapture={event => { openFileLinkFromEvent(event, props.ctx.activeSession) }}>
    <div ref={containerRef} className="renderer-suite-workbench-mount" hidden={fatal} />
    {fatal && failure && hostPortRef.current && <ReactWorkbenchFatalFallback document={hostPortRef.current.document} failure={failure}
      onRetry={retrySolid}
      onSelectSuite={selectSuite}
      onOpenDiagnostics={openDiagnostics}
      onOpenMedia={hostPortRef.current.capabilities.has('resourceOpen') ? openFallbackMedia : undefined}
      onDownloadMedia={hostPortRef.current.capabilities.has('resourceOpen') ? downloadFallbackMedia : undefined}
      onOpenInteractionUrl={hostPortRef.current.capabilities.has('resourceOpen') ? openFallbackInteractionUrl : undefined}
      onCopyInteractionUrl={hostPortRef.current.capabilities.has('clipboardWrite') ? copyFallbackInteractionUrl : undefined}
      onOpenResource={hostPortRef.current.capabilities.has('resourceOpen') ? openFallbackInteractionUrl : undefined}
      onCopyResource={hostPortRef.current.capabilities.has('clipboardWrite') ? copyFallbackInteractionUrl : undefined}
      onRetryMessage={hostPortRef.current.capabilities.has('retry') ? retryFallbackMessage : undefined}
      onRecoverSession={hostPortRef.current.capabilities.has('recovery') ? recoverFallbackSession : undefined}
      onRespondInteraction={hostPortRef.current.capabilities.has('interactionResponse') ? respondFallbackInteraction : undefined} />}
    {!fatal && failure && <div className="renderer-suite-fallback-banner" role="status"
      data-failed-suite-id={failure.suiteId} data-failed-plugin-id={failure.pluginId} data-failure-phase={failure.phase}>
      {failure.retained ? 'Suite 候选未生效，继续使用健康实例' : 'Suite 已安全回退'}：{failure.suiteId} / {failure.phase} / {failure.message}
      <div className="renderer-suite-fallback-actions">
        <button type="button" onClick={retrySolid}>重试 Solid</button>
        <button type="button" onClick={selectSuite}>切换 Suite</button>
        <button type="button" onClick={openDiagnostics}>打开诊断</button>
      </div>
    </div>}
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
  useEffect(() => {
    if (props.session && lifecycle.canonicalRefresh?.sessionId === props.session.id) void props.sessionRuntime.bind(props.session)
  }, [props.sessionRuntime, props.session, lifecycle.canonicalRefresh])
  return lifecycle.recoveryFailure
    ? <div className="renderer-suite-recovery-banner" role="alert">会话恢复失败：{lifecycle.recoveryFailure.message}</div>
    : null
}
