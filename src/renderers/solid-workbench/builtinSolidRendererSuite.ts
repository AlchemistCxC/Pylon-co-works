import type { RendererSlotContribution, RendererSuiteContribution } from '../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import type { RenderAppearanceSnapshot, RenderNodeSnapshot, RenderSurface } from '../../contracts/messageRenderer.ts'
import type { RendererPrepareContext, WorkbenchHostPort, WorkbenchMountInput, WorkbenchRendererFactory, WorkbenchRendererInstance } from './workbenchContracts.ts'
import { loadSolidWorkbench } from './loadSolidWorkbench.ts'
import { loadBuiltinSolidContentSlot } from './loadBuiltinSolidContentSlot.ts'
import { BUILTIN_TEXT_RENDER_KINDS } from '../../domains/rendererContent/textRenderKindCatalog.ts'

export const BUILTIN_SOLID_SUITE_ID = 'builtin.solid'
export const BUILTIN_SOLID_CONTENT_SLOT_ID = 'builtin.solid.content.base'

export const BUILTIN_SOLID_CONTENT_KINDS = Object.freeze([
  ...BUILTIN_TEXT_RENDER_KINDS.map(kind => kind.id).filter(kind => kind.startsWith('content.')),
  'content.plan',
  'lifecycle.retry',
  'lifecycle.compact',
  'lifecycle.rewind',
  'lifecycle.suspended',
  'lifecycle.recovered',
  'system.notice',
  'system.error',
  'content.unknown',
])

interface BuiltinSolidContentHandle {
  destroyed: boolean
  ready: Promise<void>
  pendingSnapshot: RenderNodeSnapshot
  pendingAppearance: RenderAppearanceSnapshot
  setState?: (state: { snapshot: RenderNodeSnapshot; appearance: RenderAppearanceSnapshot }) => void
  dispose?: () => void
}

function createBuiltinSolidContentSurface(): RenderSurface {
  const errorListeners = new Set<(payload: unknown) => void>()
  let surfaceDestroyed = false
  const emitError = (error: unknown) => {
    if (surfaceDestroyed) return
    for (const listener of [...errorListeners]) listener(error)
  }
  return {
    rendererId: BUILTIN_SOLID_CONTENT_SLOT_ID,
    kind: 'solid',
    mount(container, snapshot, appearance, commands) {
      const handle: BuiltinSolidContentHandle = {
        destroyed: false,
        ready: Promise.resolve(),
        pendingSnapshot: snapshot,
        pendingAppearance: appearance,
      }
      handle.ready = Promise.all([
        import('solid-js'),
        import('solid-js/web'),
        loadBuiltinSolidContentSlot(),
      ]).then(([{ createSignal }, { createComponent, render }, BuiltinSolidContentSlot]) => {
        if (handle.destroyed) return
        const [state, setState] = createSignal({
          snapshot: handle.pendingSnapshot,
          appearance: handle.pendingAppearance,
        })
        handle.setState = setState
        handle.dispose = render(
          () => (createComponent as (component: unknown, props: unknown) => unknown)(BuiltinSolidContentSlot, {
            get snapshot() { return state().snapshot },
            get appearance() { return state().appearance },
            commands,
          }) as never,
          container,
        )
      }).catch(emitError)
      return handle
    },
    update(handle, snapshot, appearance) {
      const value = handle as BuiltinSolidContentHandle
      value.pendingSnapshot = snapshot
      value.pendingAppearance = appearance
      if (!value.destroyed) value.setState?.({ snapshot, appearance })
    },
    destroy(handle) {
      const value = handle as BuiltinSolidContentHandle
      value.destroyed = true
      surfaceDestroyed = true
      errorListeners.clear()
      void value.ready.then(() => {
        value.dispose?.()
        value.dispose = undefined
      })
    },
    on(event, listener) {
      if (event !== 'error') return () => {}
      errorListeners.add(listener)
      return () => errorListeners.delete(listener)
    },
  }
}

const factory: WorkbenchRendererFactory = Object.freeze({
  async prepare(context: RendererPrepareContext) {
    const module = await loadSolidWorkbench()
    return {
      mount(container: HTMLElement, input: WorkbenchMountInput, host: WorkbenchHostPort): WorkbenchRendererInstance {
        return module.mountSolidWorkbenchFromHostPort({ host: container, input, hostPort: host, activation: context.activation })
      },
    }
  },
})

export function createBuiltinSolidRendererSuite(): RendererSuiteContribution {
  return Object.freeze({
    id: BUILTIN_SOLID_SUITE_ID,
    label: 'Pylon Solid Workbench',
    description: '内置 SolidJS Agent 工作台',
    apiVersion: 1,
    runtime: Object.freeze({ framework: 'solid', version: '1.0.0' }),
    compatibility: Object.freeze({ documentSchema: 'workbench.v1', renderCatalogSchema: 1 }),
    requiredKinds: Object.freeze(BUILTIN_TEXT_RENDER_KINDS.map(kind => kind.id)),
    // Canonical plan/lifecycle/diagnostic projections are registered by the
    // built-in content plugin and consumed through the same Suite-local Slot seam.
    optionalKinds: Object.freeze(BUILTIN_SOLID_CONTENT_KINDS.filter(kind => (
      kind === 'content.plan' || kind.startsWith('lifecycle.') || kind.startsWith('system.')
    ))),
    factory,
  })
}

export function createBuiltinSolidContentSlot(): RendererSlotContribution {
  return Object.freeze({
    id: BUILTIN_SOLID_CONTENT_SLOT_ID,
    label: 'Pylon Solid built-in content',
    description: 'C00–C13 内置 Solid Suite base Slot',
    targetSuites: Object.freeze([BUILTIN_SOLID_SUITE_ID]),
    kinds: BUILTIN_SOLID_CONTENT_KINDS,
    priority: 10_000,
    fallback: true,
    canRender: (input: RenderNodeSnapshot) => BUILTIN_SOLID_CONTENT_KINDS.includes(input.kind),
    createSurface: () => createBuiltinSolidContentSurface(),
  })
}
