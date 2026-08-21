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

export function mountSolidWorkbench({ host, input: initialInput, services, hostPort: providedHostPort }: SolidWorkbenchMountInput): SolidWorkbenchLifecycle {
  let destroyed = false
  let paused = false
  const [input, setInput] = createSignal<SolidWorkbenchInput>(normalizeWorkbenchMountInput(initialInput))
  const [runtimeSnapshot, setRuntimeSnapshot] = createSignal(services.runtime.getSnapshot())
  const [appearanceSnapshot, setAppearanceSnapshot] = createSignal(services.appearance.getSnapshot())
  const [pausedSignal, setPausedSignal] = createSignal(false)
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
      hostPort.diagnostics.destroy?.()
      listeners.clear()
    },
    on(event, listener) {
      if (event === 'ready' && ready) listener({ suiteId: 'builtin.solid' })
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
