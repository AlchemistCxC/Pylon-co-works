import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { SolidWorkbenchApp } from './SolidWorkbenchApp.solid.tsx'
import type { SolidWorkbenchContextValue } from './SolidWorkbenchContext.solid.tsx'
import type {
  SolidWorkbenchInput,
  SolidWorkbenchLifecycle,
  SolidWorkbenchMountInput,
} from './workbenchContracts.ts'
import { normalizeWorkbenchMountInput } from './workbenchContracts.ts'
import { createWorkbenchHostPort } from './workbenchHostPort.ts'
import type { WorkbenchHostPort, WorkbenchMountInput } from './workbenchContracts.ts'
import type { WorkbenchRuntimeSnapshot } from '../../domains/workbench/workbenchRuntime.ts'
import { createSolidWorkbenchServicesFromHostPort } from './hostPortSolidServices.ts'
import { canonicalTokenCount } from './solidWorkbenchProjectionSupport.ts'
import type { RendererActivationSnapshot } from '../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import { createStreamingDisplayScheduler } from './streamingDisplayScheduler.ts'
import { createPredictionRouter, createStandalonePredictionProvider } from '../../domains/inputPrediction/inputPredictionSettings.ts'

/**
 * P57 S2-R1d（第一步：渲染器侧门控）显示相关字段签名。
 *
 * usage/config 类 0 文本事件（timeline/appliedEventIds/session.usage 对象每事件换新）
 * 在 R1a/R1b/R1c 之后所有显示消费引用全稳 → 签名全等 → 不向 Solid 显示链发表。
 * usage 的显示消费是数值（canonicalTokenCount → footer tokenCount），因此数值变化
 * 必然改变签名、必须放行；timeline 仅被纯标记空 div 消费，不进签名。
 * runtime 契约零改动：slice 通知、revision 语义均不受影响。
 */
export function displayGateSignature(snapshot: WorkbenchRuntimeSnapshot): readonly unknown[] {
  const document = snapshot.document
  return [
    snapshot.sessionId, snapshot.ownerKey, snapshot.generation, snapshot.turnEpoch,
    snapshot.status, snapshot.error,
    snapshot.generating, snapshot.generationStart, snapshot.lastTokenAt, snapshot.thinkingStart,
    snapshot.generationPhase, snapshot.generationActivity, snapshot.summary,
    snapshot.tokenCount,
    canonicalTokenCount(document?.session.usage, snapshot.tokenCount),
    snapshot.tasks, snapshot.messages,
    snapshot.availableModels, snapshot.activeModel, snapshot.availableModes, snapshot.activeMode,
    snapshot.canAttach, snapshot.promptImage, snapshot.terminalFence,
    document?.messages, document?.activities, document?.diagnostics,
    document?.interactions, document?.extensions, document?.systemErrors,
    document?.lifecycle, document?.plan, document?.goal, document?.assist,
    document?.session.status, document?.session.model, document?.session.mode,
    document?.session.options, document?.session.commands,
  ]
}

export function mountSolidWorkbench({ host, input: initialInput, services, hostPort: providedHostPort, activation }: SolidWorkbenchMountInput & { activation?: RendererActivationSnapshot }): SolidWorkbenchLifecycle {
  let destroyed = false
  let paused = false
  const [input, setInput] = createSignal<SolidWorkbenchInput>(normalizeWorkbenchMountInput(initialInput))
  const initialRuntimeSnapshot = services.runtime.getSnapshot()
  const [runtimeSnapshot, setRuntimeSnapshot] = createSignal(initialRuntimeSnapshot)
  const [appearanceSnapshot, setAppearanceSnapshot] = createSignal(services.appearance.getSnapshot())
  const [pausedSignal, setPausedSignal] = createSignal(false)
  const ownsHostPort = providedHostPort === undefined && services.hostPort === undefined
  const hostPort = providedHostPort ?? services.hostPort ?? createWorkbenchHostPort({
    runtime: services.runtime,
    appearance: services.appearance,
    sessionUi: services.sessionUi,
    commands: services.commands,
    suiteId: 'builtin.solid',
    sheetId: initialInput.sheetId,
    sessionOwnerKey: initialInput.sessionOwnerKey ?? null,
    sessionId: initialInput.sessionId,
  })
  const listeners = new Map<'ready' | 'error' | 'request-action', Set<(payload: unknown) => void>>()
  // Runtime facts stay lossless and latest-wins. Only the snapshot consumed by
  // the Solid tree is paced, so a dense token burst cannot trigger a render
  // storm while canonical/replay consumers continue to see every event.
  const streamingDisplay = createStreamingDisplayScheduler(snapshot => {
    if (!destroyed && !paused) setRuntimeSnapshot(snapshot)
  })
  const publishRuntimeSnapshot = (snapshot: WorkbenchRuntimeSnapshot) => {
    // Preview fixtures intentionally remain deterministic; production mounts
    // use the same scheduler with the normal latest-wins cadence.
    if (input().preview) streamingDisplay.flush(snapshot)
    else streamingDisplay.push(snapshot)
  }
  if (initialInput.preview) streamingDisplay.flush(initialRuntimeSnapshot)
  else streamingDisplay.push(initialRuntimeSnapshot)
  let ready = false
  let lastError: unknown
  const emit = (event: 'ready' | 'error' | 'request-action', payload: unknown) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(payload)
  }

  // P57 S2-R1d：渲染器侧 display-gate。runtime 通知照常到达，但仅当显示相关签名
  // 变化时才把快照交给调度器/显示链；usage 数值变化改变签名、必然放行。
  let lastPublishedSnapshot: WorkbenchRuntimeSnapshot | undefined = initialRuntimeSnapshot
  const unsubscribeRuntime = services.runtime.subscribe(() => {
    if (destroyed) return
    const snapshot = services.runtime.getSnapshot()
    if (lastPublishedSnapshot !== undefined) {
      const previous = displayGateSignature(lastPublishedSnapshot)
      const next = displayGateSignature(snapshot)
      if (previous.length === next.length && previous.every((value, index) => value === next[index])) return
    }
    // Keep the scheduler's target current even while paused; resume() will
    // flush this latest snapshot in one deterministic publication.
    lastPublishedSnapshot = snapshot
    publishRuntimeSnapshot(snapshot)
  })
  const unsubscribeAppearance = services.appearance.subscribe(() => {
    if (!destroyed && !paused) setAppearanceSnapshot(services.appearance.getSnapshot())
  })

  const context: SolidWorkbenchContextValue = {
    input,
    runtime: services.runtime,
    runtimeSnapshot,
    appearance: services.appearance,
    appearanceSnapshot,
    sessionUi: services.sessionUi,
    commands: services.commands,
    sessionCreation: services.sessionCreation ?? services.commands.sessionCreation ?? hostPort.sessionCreation,
    hostPort,
    predictionProvider: createPredictionRouter({
      forkProvider: services.predictionProvider ?? hostPort.predictionProvider,
      standaloneProvider: createStandalonePredictionProvider(),
    }),
    paused: pausedSignal,
    reportRendererError(error) {
      const payload = {
        message: error instanceof Error ? error.message : String(error),
        error,
      }
      lastError = payload
      // Notify the listeners that existed when Solid reported the failure.
      // A listener attached after mount receives lastError synchronously below,
      // so it must not also be included in this queued delivery.
      const current = [...(listeners.get('error') ?? [])]
      queueMicrotask(() => { for (const listener of current) listener(payload) })
    },
    reportRendererAction(action) { emit('request-action', action) },
    activation,
  }
  const dispose = render(() => <SolidWorkbenchApp context={context} />, host)
  ready = true

  return {
    update(nextInput) {
      if (destroyed) return
      setInput(normalizeWorkbenchMountInput(nextInput))
    },
    pause() {
      if (destroyed || paused) return
      paused = true
      streamingDisplay.pause()
      setPausedSignal(true)
    },
    resume() {
      if (destroyed || !paused) return
      paused = false
      const latest = services.runtime.getSnapshot()
      lastPublishedSnapshot = latest
      streamingDisplay.resume(latest)
      setAppearanceSnapshot(services.appearance.getSnapshot())
      setPausedSignal(false)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      streamingDisplay.dispose()
      unsubscribeRuntime()
      unsubscribeAppearance()
      dispose()
      host.replaceChildren()
      if (ownsHostPort) hostPort.diagnostics.destroy?.()
      listeners.clear()
    },
    on(event, listener) {
      if (event === 'ready' && ready) listener({ suiteId: 'builtin.solid' })
      if (event === 'error' && lastError !== undefined) listener(lastError)
      const group = listeners.get(event) ?? new Set<(payload: unknown) => void>()
      group.add(listener)
      listeners.set(event, group)
      return () => {
        group.delete(listener)
        if (group.size === 0) listeners.delete(event)
      }
    },
  }
}

export function mountSolidWorkbenchFromHostPort(input: {
  host: HTMLElement
  input: WorkbenchMountInput
  hostPort: WorkbenchHostPort
  activation?: RendererActivationSnapshot
}): SolidWorkbenchLifecycle {
  return mountSolidWorkbench({
    host: input.host,
    input: input.input,
    hostPort: input.hostPort,
    activation: input.activation,
    services: createSolidWorkbenchServicesFromHostPort(input.hostPort),
  })
}
