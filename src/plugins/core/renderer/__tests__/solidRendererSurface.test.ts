// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  RenderAppearanceSnapshot,
  RenderCommandPort,
  RenderNodeSnapshot,
} from '../../../../contracts/messageRenderer.ts'
import { createSolidSurface } from '../solidRenderer.ts'

const appearance: RenderAppearanceSnapshot = Object.freeze({
  userName: 'You', userPrefix: '❯', userColor: '#fff',
  assistantDot: false, assistantDotGlyph: '●', assistantDotImage: '',
  toolIndicator: '●', toolIndicatorGlow: 0, toolIndicatorGlowColor: '#fff',
})
const commands: RenderCommandPort = Object.freeze({ execute: vi.fn() })

function snapshot(revision: number): RenderNodeSnapshot {
  return Object.freeze({
    nodeId: 'streaming-message',
    kind: 'message.assistant',
    revision,
    payload: Object.freeze({
      reduceMotion: true,
      renderMessage: Object.freeze({
        type: 'assistant',
        message: Object.freeze({
          id: 'streaming-message', role: 'assistant', sender: 'peri',
          content: `chunk-${revision}`, time: '10:00',
        }),
      }),
    }),
  })
}

afterEach(() => document.body.replaceChildren())

describe('Solid semantic RenderSurface', () => {
  it('mount 一次后 1000 次 update 保持 DOM identity，destroy 一次后静默清理', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const surface = createSolidSurface()
    const error = vi.fn()
    const unsubscribe = surface.on('error', error)
    const handle = surface.mount(container, snapshot(0), appearance, commands)
    await vi.waitFor(() => expect(container.textContent).toContain('chunk-0'), { timeout: 5000 })
    const root = container.firstElementChild
    expect(root).not.toBeNull()

    for (let revision = 1; revision <= 1000; revision += 1) {
      surface.update(handle, snapshot(revision), appearance)
    }

    expect(container.textContent).toContain('chunk-1000')
    expect(container.firstElementChild).toBe(root)
    unsubscribe()
    surface.destroy(handle)
    await vi.waitFor(() => expect(container.childElementCount).toBe(0))
    expect(error).not.toHaveBeenCalled()
  })

  it('异步 renderer loader 尚未完成时 destroy，不复活 DOM 或 error listener', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const surface = createSolidSurface()
    const error = vi.fn()
    surface.on('error', error)
    const handle = surface.mount(container, snapshot(0), appearance, commands)
    surface.destroy(handle)
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(container.childElementCount).toBe(0)
    expect(error).not.toHaveBeenCalled()
  })
})
