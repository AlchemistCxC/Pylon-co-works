import type { RendererSlotContribution, RendererSuiteContribution } from '../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import type { RenderAppearanceSnapshot, RenderNodeSnapshot, RenderSurface } from '../../contracts/messageRenderer.ts'
import type { RendererPrepareContext, WorkbenchHostPort, WorkbenchMountInput, WorkbenchRendererFactory, WorkbenchRendererInstance } from './workbenchContracts.ts'
import { loadSolidWorkbench } from './loadSolidWorkbench.ts'
import { whenStreamingComputeReady } from '../../infrastructure/compute/streamingCompute.ts'
import { whenProjectorComputeReady } from '../../infrastructure/compute/projectorCompute.ts'
import { loadBuiltinSolidContentSlot } from './loadBuiltinSolidContentSlot.ts'
import { BUILTIN_TEXT_RENDER_KINDS } from '../../domains/rendererContent/textRenderKindCatalog.ts'
import { BUILTIN_TOOL_RENDER_KINDS, SHARED_TOOL_SETTINGS_SCHEMA } from '../../domains/rendererContent/toolRenderKindCatalog.ts'
import { normalizeRendererSettingsPlacement } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { BUILTIN_EXECUTION_RENDER_KINDS } from '../../domains/rendererContent/executionRenderKindCatalog.ts'
import { BUILTIN_INTERACTION_RENDER_KINDS } from '../../domains/rendererContent/interactionRenderKindCatalog.ts'
import { BUILTIN_SESSION_RENDER_KINDS } from '../../domains/rendererContent/sessionRenderKindCatalog.ts'

export const BUILTIN_SOLID_SUITE_ID = 'builtin.solid'
export const BUILTIN_SOLID_CONTENT_SLOT_ID = 'builtin.solid.content.base'
export const BUILTIN_SOLID_TOOL_SETTINGS_SLOT_ID = BUILTIN_SOLID_CONTENT_SLOT_ID

export const BUILTIN_SOLID_CONTENT_KINDS = Object.freeze([
  ...BUILTIN_TEXT_RENDER_KINDS.map(kind => kind.id).filter(kind => kind.startsWith('content.') || kind.startsWith('diagnostic.') || kind === 'system.hook'),
  ...BUILTIN_TOOL_RENDER_KINDS.map(kind => kind.id),
  ...BUILTIN_EXECUTION_RENDER_KINDS.map(kind => kind.id),
  ...BUILTIN_INTERACTION_RENDER_KINDS.map(kind => kind.id),
  ...BUILTIN_SESSION_RENDER_KINDS.map(kind => kind.id),
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

const BUILTIN_SOLID_REQUIRED_KINDS = Object.freeze(BUILTIN_TEXT_RENDER_KINDS.map(kind => kind.id))

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
    // #220：流式文本计算核在**浏览器**宿主是异步初始化的（Node/vitest 在模块导入时
    // 同步完成）。切分与揭示引擎的调用点都是同步上下文（Solid memo、rAF 回调），
    // 就绪前调用会显式报错而不是静默降级——因此必须在首次渲染前等它。
    // `prepare` 是宿主给的异步前置，落这里最合适，且不会把 `mount` 变成异步。
    await whenStreamingComputeReady()
    // #220：投影核同址等待。bootstrap 已预热过一次（App.tsx 的 warmComputeCores），
    // 这里再等是**渲染器自足**：本 suite 消费投影文档，不该依赖宿主一定先预热过。
    // 已就绪时是零成本的空 resolved。
    await whenProjectorComputeReady()
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
    requiredKinds: BUILTIN_SOLID_REQUIRED_KINDS,
    // Canonical plan/lifecycle/diagnostic projections are registered by the
    // built-in content plugin and consumed through the same Suite-local Slot seam.
    optionalKinds: Object.freeze(BUILTIN_SOLID_CONTENT_KINDS.filter(kind => !BUILTIN_SOLID_REQUIRED_KINDS.includes(kind) && (
      kind === 'content.plan' || kind.startsWith('tool.') || kind.startsWith('activity.') || kind.startsWith('interaction.') || kind.startsWith('lifecycle.') || kind.startsWith('system.') || kind.startsWith('session.') || kind.startsWith('assist.')
    ))),
    factory,
  })
}

export function createBuiltinSolidContentSlot(): RendererSlotContribution {
  return Object.freeze({
    id: BUILTIN_SOLID_CONTENT_SLOT_ID,
    label: 'Pylon Solid built-in content',
    description: 'C00–C15 内置 Solid Suite base Slot',
    targetSuites: Object.freeze([BUILTIN_SOLID_SUITE_ID]),
    kinds: BUILTIN_SOLID_CONTENT_KINDS,
    priority: 10_000,
    fallback: true,
    canRender: (input: RenderNodeSnapshot) => BUILTIN_SOLID_CONTENT_KINDS.includes(input.kind),
    createSurface: () => createBuiltinSolidContentSurface(),
    // Shared tool appearance is owned by the content Slot. Legacy Kind
    // namespaces remain readable as per-kind exceptions in the resolver.
    settings: SHARED_TOOL_SETTINGS_SCHEMA,
    settingsPlacement: normalizeRendererSettingsPlacement({
      categoryId: 'tool-activity',
      categoryLabel: '工具活动',
      categoryOrder: 50,
      objectOrder: 0,
      disclosure: 'essential',
    }),
  })
}
