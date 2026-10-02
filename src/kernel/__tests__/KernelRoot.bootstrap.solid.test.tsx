// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * #515：迁移自 KernelRoot.bootstrap.test.tsx（React RTL → @solidjs/testing-library）。
 * 改写点登记：
 * - 动态 `await import('../KernelRoot.tsx')`（React 实体，已随根翻转删除）→ 静态
 *   `import { KernelRoot } from '../KernelRoot.solid.tsx'`（solid 实体直连）；
 * - `render(<KernelRoot/>)` → `render(() => <KernelRoot/>)`；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开）；
 * - 断言集逐字保留（recovery 层在 startNormal 前渲染、文案「Pylon Kernel 正在启动」、
 *   startNormal 恰一次）。
 */
import { cleanup, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KernelRoot } from '../KernelRoot.solid.tsx'
import { createApplicationRuntime } from '../../application/applicationRuntime.ts'
import type { KernelBootstrap } from '../kernelBootstrap.ts'

// vitest globals 未开，solid testing-library 不自动 cleanup。
afterEach(cleanup)

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

    render(() => <KernelRoot bootstrap={bootstrap} runtime={createApplicationRuntime()} />)

    expect(screen.getByTestId('kernel-recovery-layer')).toHaveTextContent('Pylon Kernel 正在启动')
    await waitFor(() => expect(startNormal).toHaveBeenCalledOnce())
  })
})
