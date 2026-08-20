// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createApplicationRuntime } from '../applicationRuntime.ts'
import type { KernelBootstrap } from '../kernelBootstrap.ts'

describe('KernelRoot bootstrap boundary', () => {
  it('renders the Kernel recovery surface before starting plugins in an effect', async () => {
    const startNormal = vi.fn(async () => undefined)
    const idle = { kind: 'idle' as const }
    const bootstrap: KernelBootstrap = {
      getSnapshot: () => idle,
      subscribe: () => () => undefined,
      startNormal,
      startSafeMode: vi.fn(async () => undefined),
      retryPlugin: vi.fn(async () => undefined),
    }
    const { KernelRoot } = await import('../KernelRoot.tsx')

    render(<KernelRoot bootstrap={bootstrap} runtime={createApplicationRuntime()} />)

    expect(screen.getByTestId('kernel-recovery-layer')).toHaveTextContent('Pylon Kernel 正在启动')
    await waitFor(() => expect(startNormal).toHaveBeenCalledOnce())
  })
})
