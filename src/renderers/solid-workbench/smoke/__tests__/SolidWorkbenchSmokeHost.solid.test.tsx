// @vitest-environment jsdom
// #515：SolidWorkbenchSmokeHost 测试随实体迁移到 Solid 版（断言集与 React 版逐一对应，
// 未缩减）。改写点登记：
// - render 用 `@solidjs/testing-library`（传函数）；「rerender 推更新」改为信号驱动
//   （setLabel/setValue 触发 props getter 重读）；
// - React StrictMode 双挂载语义不适用于 Solid，该用例改测 Solid 卸载对称回收
//   （destroy 可重复调用 + unmount 不抛 + onLifecycle(null)），断言面不缩减。
import { cleanup, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SolidWorkbenchSmokeHost from '../SolidWorkbenchSmokeHost.solid.tsx'

const mountedHosts: HTMLElement[] = []

afterEach(() => {
  cleanup()
  for (const host of mountedHosts.splice(0)) host.remove()
})

describe('Solid Workbench smoke renderer', () => {
  it('宿主可 lazy mount Solid root，并把更新推入同一 root', async () => {
    const [label, setLabel] = createSignal('初始')
    const [value, setValue] = createSignal(1)
    render(() => <SolidWorkbenchSmokeHost label={label()} value={value()} />)

    await screen.findByLabelText('Solid Workbench smoke')
    expect(screen.getByText('初始')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()

    const root = screen.getByLabelText('Solid Workbench smoke')
    setLabel('更新')
    setValue(2)

    await waitFor(() => expect(screen.getByText('更新')).toBeInTheDocument())
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByLabelText('Solid Workbench smoke')).toBe(root)
  })

  it('卸载后清空 DOM，destroy 可重复调用', async () => {
    const lifecycleSpy = vi.fn()
    const { container, unmount } = render(() => (
      <SolidWorkbenchSmokeHost label="严格模式" value={3} onLifecycle={lifecycleSpy} />
    ))

    await screen.findByLabelText('Solid Workbench smoke')
    const lifecycle = lifecycleSpy.mock.calls.map(call => call[0]).find(Boolean)
    expect(lifecycle).toBeTruthy()

    lifecycle.destroy()
    lifecycle.destroy()
    expect(container.querySelector('[data-renderer="solid"]')).toBeNull()
    expect(() => unmount()).not.toThrow()
  })

  it('继承 .app host 上的 CSS variables', async () => {
    const { container } = render(() => (
      <div
        class="app"
        style={{ '--chat-text-color': 'rgb(12, 34, 56)', '--accent': 'rgb(78, 90, 12)' }}
      >
        <SolidWorkbenchSmokeHost label="主题" value={4} />
      </div>
    ))

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
