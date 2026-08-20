// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SolidWorkbenchSmokeHost from '../SolidWorkbenchSmokeHost.tsx'

const mountedHosts: HTMLElement[] = []

afterEach(() => {
  cleanup()
  for (const host of mountedHosts.splice(0)) host.remove()
})

describe('Solid Workbench smoke renderer', () => {
  it('React host 可 lazy mount Solid root，并把更新推入同一 root', async () => {
    const { rerender } = render(<SolidWorkbenchSmokeHost label="初始" value={1} />)

    await screen.findByLabelText('Solid Workbench smoke')
    expect(screen.getByText('初始')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()

    const root = screen.getByLabelText('Solid Workbench smoke')
    rerender(<SolidWorkbenchSmokeHost label="更新" value={2} />)

    await waitFor(() => expect(screen.getByText('更新')).toBeInTheDocument())
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByLabelText('Solid Workbench smoke')).toBe(root)
  })

  it('StrictMode 下卸载后清空 DOM，destroy 可重复调用', async () => {
    const lifecycleSpy = vi.fn()
    const { container, unmount } = render(
      <StrictMode>
        <SolidWorkbenchSmokeHost label="严格模式" value={3} onLifecycle={lifecycleSpy} />
      </StrictMode>,
    )

    await screen.findByLabelText('Solid Workbench smoke')
    const lifecycle = lifecycleSpy.mock.calls.map(call => call[0]).find(Boolean)
    expect(lifecycle).toBeTruthy()

    lifecycle.destroy()
    lifecycle.destroy()
    expect(container.querySelector('[data-renderer="solid"]')).toBeNull()
    expect(() => unmount()).not.toThrow()
  })

  it('继承 React .app host 上的 CSS variables', async () => {
    const { container } = render(
      <div className="app" style={{ '--chat-text-color': 'rgb(12, 34, 56)', '--accent': 'rgb(78, 90, 12)' } as React.CSSProperties}>
        <SolidWorkbenchSmokeHost label="主题" value={4} />
      </div>,
    )

    const root = await screen.findByLabelText('Solid Workbench smoke')
    const output = root.querySelector('output')!
    const app = container.querySelector('.app') as HTMLElement
    expect(getComputedStyle(app).getPropertyValue('--chat-text-color').trim()).toBe('rgb(12, 34, 56)')
    expect(getComputedStyle(app).getPropertyValue('--accent').trim()).toBe('rgb(78, 90, 12)')
    expect(root.closest('.app')).toBe(app)
    expect(output).toBeTruthy()
    expect(container.querySelector('[data-ready="true"]')).toBeTruthy()
  })
})
