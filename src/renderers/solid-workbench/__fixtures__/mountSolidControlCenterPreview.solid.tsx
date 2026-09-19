import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { SolidWorkbenchContext, type SolidWorkbenchContextValue } from '../SolidWorkbenchContext.solid.tsx'
import { SolidControlCenter } from '../input/ControlCenter.solid.tsx'
import { normalizeWorkbenchMountInput, type SolidWorkbenchServices } from '../workbenchContracts.ts'

/**
 * Mount only the Solid control-center surface used by settings previews.
 *
 * This deliberately does not go through mountSolidWorkbench: the settings
 * preview needs the control-center tree without the surrounding workbench
 * chrome/document surface.  The context wiring mirrors the production
 * mount's reactive runtime/appearance subscriptions, while ownership of the
 * supplied services remains with the caller.
 */
export function mountSolidControlCenterPreview({
  host,
  services,
  sessionId = null,
}: {
  host: HTMLElement
  services: SolidWorkbenchServices
  /** 默认挂「空态」（main 契约，issue172 等用例依赖）；要「有会话」的用例显式传一个 id。 */
  sessionId?: string | null
}): () => void {
  let destroyed = false
  const [input] = createSignal(normalizeWorkbenchMountInput({
    sheetId: 'settings-preview',
    // 默认 = 空态（与 main 一致）。04b 之后空态下发送按钮与状态控件已隐藏，
    // 需要「有会话」的用例（preview 3 条）显式传 sessionId: 'preview-session'。
    sessionId,
    preview: true,
    replayReadonly: false,
    reducedMotion: true,
  }))
  const [runtimeSnapshot, setRuntimeSnapshot] = createSignal(services.runtime.getSnapshot())
  const [appearanceSnapshot, setAppearanceSnapshot] = createSignal(services.appearance.getSnapshot())

  const unsubscribeRuntime = services.runtime.subscribe(() => {
    if (!destroyed) setRuntimeSnapshot(services.runtime.getSnapshot())
  })
  const unsubscribeAppearance = services.appearance.subscribe(() => {
    if (!destroyed) setAppearanceSnapshot(services.appearance.getSnapshot())
  })

  const context: SolidWorkbenchContextValue = {
    input,
    runtime: services.runtime,
    runtimeSnapshot,
    appearance: services.appearance,
    appearanceSnapshot,
    sessionUi: services.sessionUi,
    commands: services.commands,
    hostPort: services.hostPort,
    paused: () => false,
    predictionProvider: services.predictionProvider,
  }
  const dispose = render(() => (
    <SolidWorkbenchContext.Provider value={context}>
      <SolidControlCenter />
    </SolidWorkbenchContext.Provider>
  ), host)

  return () => {
    if (destroyed) return
    destroyed = true
    unsubscribeRuntime()
    unsubscribeAppearance()
    dispose()
    host.replaceChildren()
  }
}

