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
import { createSolidWorkbenchServicesFromHostPort } from './hostPortSolidServices.ts'
import type { RendererActivationSnapshot } from '../../plugin-runtime/renderers/rendererSuiteTypes.ts'

export function mountSolidWorkbench({ host, input: initialInput, services, hostPort: providedHostPort, activation }: SolidWorkbenchMountInput & { activation?: RendererActivationSnapshot }): SolidWorkbenchLifecycle {
  let destroyed = false
  let paused = false
  const [input, setInput] = createSignal<SolidWorkbenchInput>(normalizeWorkbenchMountInput(initialInput))
  const [runtimeSnapshot, setRuntimeSnapshot] = createSignal(services.runtime.getSnapshot())
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
  let ready = false
  let lastError: unknown
  const emit = (event: 'ready' | 'error' | 'request-action', payload: unknown) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(payload)
  }

  const unsubscribeRuntime = services.runtime.subscribe(() => {
    if (!destroyed && !paused) setRuntimeSnapshot(services.runtime.getSnapshot())
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
      setPausedSignal(true)
    },
    resume() {
      if (destroyed || !paused) return
      paused = false
      setRuntimeSnapshot(services.runtime.getSnapshot())
      setAppearanceSnapshot(services.appearance.getSnapshot())
      setPausedSignal(false)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
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
