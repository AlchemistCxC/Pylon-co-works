// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ApplicationMount from '../ApplicationMount'
import KernelRecoveryLayer from '../KernelRecoveryLayer'
import { createApplicationRuntime } from '../applicationRuntime'

function DemoApplication() {
  return <div data-testid="demo-application">Pylon Application</div>
}

describe('ApplicationMount', () => {
  it('挂载 active Application，卸载后显示 Kernel Recovery UI', () => {
    const runtime = createApplicationRuntime()
    runtime.registerBuiltin({ id: 'builtin.pylon-app', component: DemoApplication })
    runtime.mount('builtin.pylon-app')

    render(
      <ApplicationMount
        runtime={runtime}
        recovery={<KernelRecoveryLayer onRemount={() => runtime.mount('builtin.pylon-app')} />}
      />,
    )

    expect(screen.getByTestId('demo-application')).toBeInTheDocument()

    act(() => runtime.unmount())

    expect(screen.queryByTestId('demo-application')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新挂载 Pylon' })).toBeInTheDocument()
  })

  it('Recovery UI 可重新挂载同一 Application，且 React Root 宿主不变', () => {
    const runtime = createApplicationRuntime()
    runtime.registerBuiltin({ id: 'builtin.pylon-app', component: DemoApplication })
    runtime.mount('builtin.pylon-app')
    const view = render(
      <div data-testid="kernel-root-host">
        <ApplicationMount
          runtime={runtime}
          recovery={<KernelRecoveryLayer onRemount={() => runtime.mount('builtin.pylon-app')} />}
        />
      </div>,
    )
    const host = screen.getByTestId('kernel-root-host')

    act(() => runtime.unmount())
    fireEvent.click(screen.getByRole('button', { name: '重新挂载 Pylon' }))

    expect(screen.getByTestId('kernel-root-host')).toBe(host)
    expect(screen.getByTestId('demo-application')).toBeInTheDocument()
    view.unmount()
  })

  it('Safe Mode lets the user explicitly start one first-party plugin', () => {
    const onRetry = vi.fn()
    render(<KernelRecoveryLayer
      state={{ kind: 'safe-mode', skippedPluginIds: ['builtin.pylon-shell'] }}
      onRetry={onRetry}
      onStartNormal={vi.fn()}
    />)

    fireEvent.click(screen.getByRole('button', { name: '启动 builtin.pylon-shell' }))

    expect(onRetry).toHaveBeenCalledWith('builtin.pylon-shell')
  })
})
