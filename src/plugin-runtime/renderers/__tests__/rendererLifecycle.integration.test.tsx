// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
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
  const snapshot = useSyncExternalStore(
    subscribeMessageRenderers,
    getMessageRendererSnapshot,
    getMessageRendererSnapshot,
  )
  return <output data-testid="renderers">
    {snapshot.messageRenderers.map(entry => entry.value.renderer.rendererId).join(',') || 'kernel-fallback'}
  </output>
}

async function ensureRenderersActive() {
  if (!getPluginRuntime().snapshot().active.some(identity => (
    identity.pluginId === BUILTIN_PYLON_RENDERERS_ID
  ))) await activateBuiltinPlugin(BUILTIN_PYLON_RENDERERS_ID)
}

afterEach(ensureRenderersActive)
beforeEach(ensureRenderersActive)

describe('Renderer UI lifecycle', () => {
  it('产品 renderer 插件停用后 DOM 响应式回收全部贡献', async () => {
    render(<RendererProbe />)
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
    render(<RendererProbe />)
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
