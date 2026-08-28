// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderSurface } from '../../../contracts/messageRenderer.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { getRendererRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import type { AsyncDisposable } from '../../../plugin-runtime/registry/types.ts'
import { resetStores } from '../../../test/resetStores.ts'
import { MessageRendererHost } from '../ChatView.tsx'
import '../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { CORE_SOLID_RENDERER_PLUGIN_ID } from '../../../plugins/core/renderer/solidRenderer.ts'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

let registration: AsyncDisposable | undefined

describe('ChatView message renderer consumption', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invoke.mockClear()
    Element.prototype.scrollIntoView = vi.fn()
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  })

  afterEach(async () => {
    await registration?.dispose()
    registration = undefined
    vi.unstubAllGlobals()
  })

  it('把 workspace mode/agent/session 传入 canRender，并在 owner 停用后回退 React renderer', async () => {
    const seen: unknown[] = []
    const surface: RenderSurface = {
      rendererId: 'test.renderer.work',
      kind: 'unknown',
      mount(container) {
        container.textContent = 'work renderer mounted'
        return container
      },
      update() {},
      destroy(handle) { (handle as HTMLElement).replaceChildren() },
      on: () => () => {},
    }
    registration = getRendererRegistry().registerMessageRenderer(
      createPluginIdentity('test.renderer.work', 'runtime-1'),
      {
        id: 'test.renderer.work.contribution',
        priority: 1,
        fallback: false,
        canRender: input => {
          seen.push(input)
          return input.context?.workspaceMode === 'work'
        },
        onError: () => 'fallback',
        renderer: {
          rendererId: 'test.renderer.work', kind: 'unknown',
          renderMessage: () => surface,
          renderTool: () => surface,
          renderReasoning: () => surface,
        },
      },
    )

    const renderMessage = {
      type: 'assistant' as const,
      message: { id: 'm1', role: 'assistant' as const, sender: 'peri', content: 'fallback message', time: '10:00' },
    }
    const context = { workspaceKind: 'agent', workspaceMode: 'work' as const, agentId: 'peri', sessionId: 'session-1' }
    const { rerender } = render(
      <MessageRendererHost
        renderMessage={renderMessage}
        reduceMotion
        rendererContext={context}
        rendererRevision={getRendererRegistry().snapshot().revision}
      />,
    )

    expect(await screen.findByText('work renderer mounted')).toBeVisible()
    expect(seen).toEqual(expect.arrayContaining([expect.objectContaining({
      role: 'assistant',
      context: { workspaceKind: 'agent', workspaceMode: 'work', agentId: 'peri', sessionId: 'session-1' },
    })]))

    await act(async () => { await registration?.dispose() })
    registration = undefined
    rerender(
      <MessageRendererHost
        renderMessage={renderMessage}
        reduceMotion
        rendererContext={context}
        rendererRevision={getRendererRegistry().snapshot().revision}
      />,
    )
    await waitFor(() => expect(screen.getByText('fallback message')).toBeVisible())
    expect(screen.queryByText('work renderer mounted')).toBeNull()
  })

  it('按 id 选择 Solid engine 时渲染语义消息，而不是把 React component 交给 Solid', async () => {
    const renderMessage = {
      type: 'assistant' as const,
      message: { id: 'm-solid', role: 'assistant' as const, sender: 'peri', content: 'solid semantic message', time: '10:01' },
    }
    const { container } = render(
      <MessageRendererHost
        renderMessage={renderMessage}
        reduceMotion
        rendererId={CORE_SOLID_RENDERER_PLUGIN_ID}
        rendererAppearance={{
          userName: 'You', userPrefix: '❯', userColor: '#fff',
          assistantDot: false, assistantDotGlyph: '●', assistantDotImage: '',
          toolIndicator: '●', toolIndicatorGlow: 0, toolIndicatorGlowColor: '#fff',
        }}
        rendererRevision={getRendererRegistry().snapshot().revision}
      />,
    )

    expect(await screen.findByText('solid semantic message')).toBeVisible()
    expect(container.querySelector('[data-message-renderer="core.renderer.solid"]')).not.toBeNull()
  })

  it('surface 接收分离的不可变 semantic snapshot、appearance 与 command port', async () => {
    const seen: unknown[][] = []
    const surface: RenderSurface = {
      rendererId: 'test.renderer.semantic', kind: 'unknown',
      mount(container, ...args) {
        seen.push(args)
        container.textContent = 'semantic surface'
        return container
      },
      update() {},
      destroy() {},
      on: () => () => {},
    }
    registration = getRendererRegistry().registerMessageRenderer(
      createPluginIdentity('test.renderer.semantic', 'runtime-semantic'),
      {
        id: 'test.renderer.semantic.contribution', priority: 1, fallback: false,
        canRender: () => true, renderer: {
          rendererId: 'test.renderer.semantic', kind: 'unknown',
          renderMessage: () => surface, renderTool: () => surface, renderReasoning: () => surface,
        },
      },
    )
    const renderMessage = {
      type: 'assistant' as const,
      message: { id: 'm-semantic', role: 'assistant' as const, sender: 'peri', content: 'semantic', time: '10:02' },
    }
    const appearance = Object.freeze({ reduceMotion: true })
    render(<MessageRendererHost
      renderMessage={renderMessage}
      reduceMotion
      rendererAppearance={appearance}
      rendererRevision={getRendererRegistry().snapshot().revision}
    />)
    expect(await screen.findByText('semantic surface')).toBeVisible()
    expect(seen[0]).toEqual([
      expect.objectContaining({ nodeId: 'm-semantic', kind: 'message.assistant', payload: expect.objectContaining({ renderMessage }) }),
      appearance,
      expect.objectContaining({ execute: expect.any(Function) }),
    ])
    expect(Object.isFrozen(seen[0][0])).toBe(true)
  })

  it('父级仅更换行 ref 回调时不重复更新静态 renderer surface', async () => {
    let updates = 0
    const surface: RenderSurface = {
      rendererId: 'test.renderer.memo', kind: 'unknown',
      mount(container) {
        container.textContent = 'memo surface'
        return container
      },
      update() { updates += 1 },
      destroy() {},
      on: () => () => {},
    }
    registration = getRendererRegistry().registerMessageRenderer(
      createPluginIdentity('test.renderer.memo', 'runtime-memo'),
      {
        id: 'test.renderer.memo.contribution', priority: 1, fallback: false,
        canRender: () => true, renderer: {
          rendererId: 'test.renderer.memo', kind: 'unknown',
          renderMessage: () => surface, renderTool: () => surface, renderReasoning: () => surface,
        },
      },
    )
    const renderMessage = {
      type: 'assistant' as const,
      message: { id: 'm-memo', role: 'assistant' as const, sender: 'peri', content: 'memo', time: '10:03' },
    }
    const { rerender } = render(
      <MessageRendererHost
        renderMessage={renderMessage}
        reduceMotion
        rowRef={() => {}}
        rendererRevision={getRendererRegistry().snapshot().revision}
      />,
    )
    expect(await screen.findByText('memo surface')).toBeVisible()
    const before = updates
    rerender(
      <MessageRendererHost
        renderMessage={renderMessage}
        reduceMotion
        rowRef={() => {}}
        rendererRevision={getRendererRegistry().snapshot().revision}
      />,
    )
    expect(updates).toBe(before)
  })
})
