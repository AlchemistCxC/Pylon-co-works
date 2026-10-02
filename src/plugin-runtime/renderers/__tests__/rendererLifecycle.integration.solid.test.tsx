// @vitest-environment jsdom
/** @jsxImportSource solid-js */
// #515 改写点登记（迁移自 rendererLifecycle.integration.test.tsx，React RTL → Solid）：
// - RTL → @solidjs/testing-library；render(() => JSX) 传函数；追加显式 afterEach cleanup()。
// - RendererProbe 的 React useSyncExternalStore(subscribe, getSnapshot, getSnapshot) 改
//   Solid 同构探针：createSignal(getSnapshot()) + subscribe 内 setSnapshot(() => getSnapshot())
//   + onCleanup 退订（与 IsolatedPluginSurface.solid.tsx 的 createRegistrySignal 同一形态）。
// - registry 语义断言逐字保留；断言集不缩减。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal, onCleanup } from 'solid-js'
import {
  activateBuiltinPlugin,
  getPluginRuntime,
} from '../../pluginCompositionRoot.ts'
import {
  getMessageRendererSnapshot,
  subscribeMessageRenderers,
} from '../../../host/messageRendererResolver.ts'
import { CORE_SOLID_RENDERER_PLUGIN_ID } from '../../../plugins/core/renderer/solidRenderer.ts'
import { BUILTIN_PYLON_RENDERERS_ID } from '../../../plugins/product/productPluginIds.ts'
import { TestPluginRuntime as PluginRuntime } from '../../testing/pluginRuntimeHarness.ts'
import type { MessageRenderer } from '../../../contracts/messageRenderer.ts'

const dummyRenderer = (rendererId: string): MessageRenderer => ({
  rendererId,
  kind: 'unknown',
  renderMessage: () => { throw new Error('not used') },
  renderTool: () => { throw new Error('not used') },
  renderReasoning: () => { throw new Error('not used') },
})

function RendererProbe() {
  // React useSyncExternalStore 的 Solid 等价：registry 快照 → 只读信号。
  const [snapshot, setSnapshot] = createSignal(getMessageRendererSnapshot())
  onCleanup(subscribeMessageRenderers(() => setSnapshot(() => getMessageRendererSnapshot())))
  return <output data-testid="renderers">
    {snapshot().messageRenderers.map(entry => entry.value.renderer.rendererId).join(',') || 'kernel-fallback'}
  </output>
}

async function ensureRenderersActive() {
  if (!getPluginRuntime().snapshot().active.some(identity => (
    identity.pluginId === BUILTIN_PYLON_RENDERERS_ID
  ))) await activateBuiltinPlugin(BUILTIN_PYLON_RENDERERS_ID)
}

afterEach(() => { cleanup(); return ensureRenderersActive() })
beforeEach(ensureRenderersActive)

describe('Renderer UI lifecycle', () => {
  it('产品 renderer 插件停用后 DOM 响应式回收全部贡献', async () => {
    render(() => <RendererProbe />)
    expect(screen.getByTestId('renderers')).toHaveTextContent('core.renderer.solid')

    const identity = getPluginRuntime().snapshot().active.find(candidate => (
      candidate.pluginId === BUILTIN_PYLON_RENDERERS_ID
    ))
    expect(identity).toBeDefined()
    await getPluginRuntime().deactivate(identity!.key)

    await waitFor(() => {
      expect(screen.getByTestId('renderers')).not.toHaveTextContent(CORE_SOLID_RENDERER_PLUGIN_ID)
      expect(screen.getByTestId('renderers')).toHaveTextContent('kernel-fallback')
    })
  })

  it('候选 activate 失败时旧 UI contribution 不闪烁且继续挂载', async () => {
    const runtime = new PluginRuntime()
    const old = await runtime.activateBuiltin({
      id: 'phase9.ui-rollback',
      activate: ({ renderer }) => {
        renderer.registerMessageRenderer({
          id: 'phase9.ui-rollback.message', renderer: dummyRenderer('phase9.ui-old'),
          priority: 20, fallback: false, canRender: () => true,
        })
      },
    })
    render(() => <RendererProbe />)
    expect(screen.getByTestId('renderers')).toHaveTextContent('phase9.ui-old')

    await expect(runtime.update({
      id: 'phase9.ui-rollback',
      activate: ({ renderer }) => {
        renderer.registerMessageRenderer({
          id: 'phase9.ui-rollback.message', renderer: dummyRenderer('phase9.ui-broken'),
          priority: 20, fallback: false, canRender: () => true,
        })
        throw new Error('candidate UI failed')
      },
    })).rejects.toThrow('candidate UI failed')

    await waitFor(() => {
      expect(screen.getByTestId('renderers')).toHaveTextContent('phase9.ui-old')
      expect(screen.getByTestId('renderers')).not.toHaveTextContent('phase9.ui-broken')
    })
    await runtime.deactivate(old.identity.key)
  })
})
