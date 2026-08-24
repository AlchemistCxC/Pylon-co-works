// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import type { PluginPackageClient, PluginPackageDescriptor } from '../../../infrastructure/plugins/pluginPackageClient.ts'
import { PackagePluginRuntimeService } from '../../packagePluginRuntime.ts'
import { getPresentationProfileRegistry, getRendererRegistry } from '../../runtimeServices.ts'
import { TestPluginRuntime } from '../../testing/pluginRuntimeHarness.ts'
import { resolveRendererActivation } from '../rendererActivationResolver.ts'
import { RendererSuiteHost } from '../../../host/renderer-suite/rendererSuiteHost.ts'
import type { WorkbenchHostPort, WorkbenchMountInput } from '../../../renderers/solid-workbench/workbenchContracts.ts'
import type { WorkbenchAppearanceSnapshot } from '../../../domains/workbench/appearance.ts'
import RendererSettingsPanel from '../../../components/settings/RendererSettingsPanel.tsx'
import { createRendererSettingsStore } from '../rendererSettingsStore.ts'
import { usePresentationPreferenceStore } from '../../../domains/presentation/presentationPreferenceStore.ts'
import type { RenderSurface } from '../../../contracts/messageRenderer.ts'

const PLUGIN_ID = 'example.solid-renderer'
const SUITE_ID = `${PLUGIN_ID}.suite`

function overlaySurface(): RenderSurface {
  return {
    rendererId: 'example.solid-overlay',
    kind: 'solid',
    mount: () => ({}),
    update: () => {},
    destroy: () => {},
    on: () => () => {},
  }
}

const input: WorkbenchMountInput = {
  sheetId: 'example-sheet', sessionOwnerKey: 'example-owner', sessionId: 'example-session', workspaceMode: 'work',
  replayReadonly: false, reducedMotion: false, visibility: 'active', rightInset: 0, preview: false,
}

function hostPort(): WorkbenchHostPort {
  const sessionUi: WorkbenchHostPort['sessionUi'] = {
    get: (_, fallback) => fallback, set: () => {}, update: (_, fallback, updater) => updater(fallback), subscribe: () => () => {},
    capture: () => ({ get: sessionUi.get, set: sessionUi.set, update: sessionUi.update, subscribe: sessionUi.subscribe, clear: sessionUi.clear }),
    clear: () => {},
  }
  return {
    document: { getSnapshot: () => undefined, subscribe: () => () => {}, getSlice: <T>() => undefined as T, subscribeSlice: () => () => {} },
    appearance: { getSnapshot: () => ({} as WorkbenchAppearanceSnapshot), subscribe: () => () => {} },
    sessionUi,
    commands: new Proxy({} as WorkbenchHostPort['commands'], { get: () => async () => ({ ok: true, value: undefined }) }),
    capabilities: { getSnapshot: () => ({}), has: () => true, subscribe: () => () => {} },
    diagnostics: { report: () => {}, getRecent: () => [], subscribe: () => () => {} },
  }
}

function descriptor(version: string): PluginPackageDescriptor {
  return {
    pluginId: PLUGIN_ID,
    version,
    packageInstanceId: `${PLUGIN_ID}@${version}-fixture`,
    manifest: {
      schema: 1,
      id: PLUGIN_ID,
      name: 'Example Solid Renderer',
      version,
      api: '1.0',
      kind: 'renderer',
      web: { entry: './dist/entry.js' },
      activation: { events: ['kernel.ready'] },
      hotSwap: { mode: 'parallel' },
    },
    files: [],
    totalBytes: 1,
    active: false,
  }
}

function fakePackages(input: PluginPackageDescriptor | readonly PluginPackageDescriptor[]): PluginPackageClient {
  const descriptors = Array.isArray(input) ? input : [input]
  let index = 0
  return {
    stage: vi.fn(async () => {
      const packageDescriptor = descriptors[Math.min(index++, descriptors.length - 1)]!
      return { operationId: `stage-${packageDescriptor.version}`, package: packageDescriptor }
    }),
    commitStage: vi.fn(async operationId => ({ operationId, package: descriptors[Math.max(0, index - 1)]! })),
    abortStage: vi.fn(async () => undefined),
    resourceUrl: vi.fn(async (packageId, path, runtimeId) => `pylon-plugin://${packageId}/${path}?runtime=${runtimeId}`),
    createRuntime: vi.fn(async () => undefined),
    cleanupRuntime: vi.fn(async () => undefined),
  } as unknown as PluginPackageClient
}

describe('third-party Solid renderer package', () => {
  let runtime: TestPluginRuntime | undefined

  async function install(version = '1.0.0') {
    const packageDescriptor = descriptor(version)
    runtime = new TestPluginRuntime()
    const service = new PackagePluginRuntimeService({
      runtime,
      packages: fakePackages(packageDescriptor),
      createRuntimeId: packageId => `${packageId}#test`,
      importEntry: async () => import('../../../../examples/plugins/example.solid-renderer/dist/entry.js'),
    })
    return service.activateFromDirectory('C:/fixtures/example.solid-renderer', PLUGIN_ID)
  }

  afterEach(async () => {
    if (runtime) {
      const active = runtime.snapshot().active.find(identity => identity.pluginId === PLUGIN_ID)
      if (active) await runtime.deactivate(active.key)
      runtime = undefined
    }
    usePresentationPreferenceStore.setState({ rendererSuiteIdByMode: {} })
  })

  it('activates through package staging and contributes Suite, kind, slot and Profile', async () => {
    await install()

    expect(getRendererRegistry().snapshot().rendererSuites.some(entry => entry.value.id === SUITE_ID)).toBe(true)
    expect(getRendererRegistry().snapshot().renderKinds.some(entry => entry.value.id === `${PLUGIN_ID}.note`)).toBe(true)
    expect(getRendererRegistry().snapshot().rendererSlots.some(entry => entry.value.id === `${PLUGIN_ID}.base`)).toBe(true)
    expect(getPresentationProfileRegistry().resolve(`${PLUGIN_ID}.profile`)?.value).toMatchObject({ interfaceMode: 'modern-gui' })
  })

  it('uninstall disposes every Suite, Slot, kind and Profile contribution', async () => {
    await install()
    const active = runtime!.snapshot().active.find(identity => identity.pluginId === PLUGIN_ID)
    expect(active).toBeDefined()
    await runtime!.deactivate(active!.key)
    expect(getRendererRegistry().snapshot().rendererSuites.some(entry => entry.value.id === SUITE_ID)).toBe(false)
    expect(getRendererRegistry().snapshot().renderKinds.some(entry => entry.value.id === `${PLUGIN_ID}.note`)).toBe(false)
    expect(getRendererRegistry().snapshot().rendererSlots.some(entry => entry.value.id === `${PLUGIN_ID}.base`)).toBe(false)
    expect(getPresentationProfileRegistry().resolve(`${PLUGIN_ID}.profile`)).toBeUndefined()
  })

  it('mounts the external Solid Suite through the same RendererSuiteHost seam', async () => {
    await install()
    const activation = resolveRendererActivation(getRendererRegistry().snapshot(), { explicitSuiteId: SUITE_ID })
    const container = document.createElement('div')
    const host = new RendererSuiteHost({ container, hostPort: hostPort(), input, readyTimeoutMs: 1_000 })
    await host.mount(activation)
    expect(container.querySelector('[data-example-solid-suite]')).not.toBeNull()
    await host.destroy()
    expect(container.childElementCount).toBe(0)
  })

  it('updates the package through a shadow transaction without duplicate contributions', async () => {
    const one = descriptor('1.0.0')
    const two = descriptor('2.0.0')
    runtime = new TestPluginRuntime()
    const service = new PackagePluginRuntimeService({
      runtime,
      packages: fakePackages([one, two]),
      createRuntimeId: packageId => `${packageId}#hot`,
      importEntry: async () => import('../../../../examples/plugins/example.solid-renderer/dist/entry.js'),
    })
    const active = await service.activateFromDirectory('C:/fixtures/example.solid-renderer/v1', PLUGIN_ID)
    const updated = await service.updateFromDirectory('C:/fixtures/example.solid-renderer/v2', PLUGIN_ID)
    expect(updated.previousRuntimeInstanceId).toBe(active.runtimeInstanceId)
    expect(updated.runtimeInstanceId).not.toBe(active.runtimeInstanceId)
    expect(getRendererRegistry().snapshot().rendererSuites.filter(entry => entry.value.id === SUITE_ID)).toHaveLength(1)
    expect(getRendererRegistry().snapshot().rendererSuites.find(entry => entry.value.id === SUITE_ID)?.ownerRuntimeInstanceId).toBe(updated.runtimeInstanceId)
  })

  it('exposes the external Suite and Slot settings through the generated settings panel', async () => {
    await install()
    usePresentationPreferenceStore.getState().setRendererSuiteId('modern-gui', SUITE_ID)
    const store = createRendererSettingsStore({ storage: undefined })
    render(createElement(RendererSettingsPanel, { store }))
    expect(screen.getByLabelText('密度')).toBeTruthy()
    expect(screen.getByLabelText('强调色')).toBeTruthy()
    expect(screen.getByLabelText('字号缩放')).toBeTruthy()
    expect(screen.getByLabelText('启用 Suite 装饰')).toBeTruthy()
    // S4 同类迁移（施工书 06 §S4）：density 声明 segmented → 按钮组 click 写入
    // K-3：segmented 底座 Radix ToggleGroup——Item 语义为 radio
    fireEvent.click(screen.getByRole('radio', { name: '宽松' }))
    expect(store.getSnapshot().values[`${'suite'}.${SUITE_ID}.density`]).toBe('roomy')
    expect(screen.getByRole('status')).toHaveTextContent(PLUGIN_ID)
  })

  it('allows an explicitly targeted overlay and restores the base Slot on owner cleanup', async () => {
    await install()
    const overlay = await runtime!.activateBuiltin({
      id: 'example.solid-overlay',
      activate: ({ renderer }) => { renderer.registerSlot({
        id: 'example.solid-overlay.slot',
        targetSuites: [SUITE_ID],
        kinds: [`${PLUGIN_ID}.note`],
        priority: 1,
        fallback: false,
        canRender: () => true,
        createSurface: () => overlaySurface(),
      }) },
    })
    const withOverlay = resolveRendererActivation(getRendererRegistry().snapshot(), { explicitSuiteId: SUITE_ID })
    expect(withOverlay.slots.get(`${PLUGIN_ID}.note`)?.[0].value.id).toBe('example.solid-overlay.slot')
    await runtime!.deactivate(overlay.identity.key)
    const restored = resolveRendererActivation(getRendererRegistry().snapshot(), { explicitSuiteId: SUITE_ID })
    expect(restored.slots.get(`${PLUGIN_ID}.note`)?.[0].value.id).toBe(`${PLUGIN_ID}.base`)
  })
})
