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
import type { RendererActivationSnapshot } from '../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import { createStreamingDisplayScheduler } from './streamingDisplayScheduler.ts'

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

  const unsubscribeRuntime = services.runtime.subscribe(() => {
    if (destroyed) return
    const snapshot = services.runtime.getSnapshot()
    // Keep the scheduler's target current even while paused; resume() will
    // flush this latest snapshot in one deterministic publication.
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
    hostPort,
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
      streamingDisplay.resume(services.runtime.getSnapshot())
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
