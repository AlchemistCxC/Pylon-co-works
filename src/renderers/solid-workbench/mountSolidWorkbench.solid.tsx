import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { SolidWorkbenchApp } from './SolidWorkbenchApp.solid.tsx'
import type { SolidWorkbenchContextValue } from './SolidWorkbenchContext.solid.tsx'
import type {
  SolidWorkbenchInput,
  SolidWorkbenchLifecycle,
  SolidWorkbenchMountInput,
} from './workbenchContracts.ts'

export function mountSolidWorkbench({ host, input: initialInput, services }: SolidWorkbenchMountInput): SolidWorkbenchLifecycle {
  let destroyed = false
  let paused = false
  const [input, setInput] = createSignal<SolidWorkbenchInput>({ ...initialInput })
  const [runtimeSnapshot, setRuntimeSnapshot] = createSignal(services.runtime.getSnapshot())
  const [appearanceSnapshot, setAppearanceSnapshot] = createSignal(services.appearance.getSnapshot())
  const [pausedSignal, setPausedSignal] = createSignal(false)

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
    paused: pausedSignal,
  }
  const dispose = render(() => <SolidWorkbenchApp context={context} />, host)

  return {
    update(nextInput) {
      if (destroyed) return
      setInput({ ...nextInput })
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
    },
  }
}
