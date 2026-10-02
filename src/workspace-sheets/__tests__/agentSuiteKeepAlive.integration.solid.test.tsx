// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * #515：迁移自 agentSuiteKeepAlive.integration.test.tsx（React RTL → @solidjs/testing-library）。
 * 改写点登记：
 * - `render(<SheetLayout/>)` → `render(() => <SheetLayout/>)`，实体直连 SheetLayout.solid.tsx；
 * - `act(() => focusSheet(...))` → 直接调用 store action（Solid 无 act；store 通知同步落盘；
 *   pause/resume 经 workbench host 异步到达，仍以 waitFor 等待真实条件）；
 * - `view.unmount()` 语义不变（solid testing-library render 返回同名 unmount）；
 * - 断言集逐字保留（mount 恰一次、pause/resume 恰一次、destroy 不调用、
 *   workbench host port 挂载期在场/卸载后清理、rightInset:0 不叠加）。
 */
import { cleanup, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import SheetLayout from '../SheetLayout.solid.tsx'
import { resetStores } from '../../test/resetStores.ts'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore.ts'
import { getRendererRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { getActiveWorkbenchHostPort } from '../../application/agent-workbench/activeWorkbenchHostPort.ts'

// vitest globals 未开，solid testing-library 不自动 cleanup。
afterEach(cleanup)

describe('Agent Renderer Suite tab lifecycle', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('切离 Agent Sheet 只 pause，切回 resume，renderer 不重建', async () => {
    const mount = vi.fn()
    const pause = vi.fn()
    const resume = vi.fn()
    const destroy = vi.fn()
    const registration = getRendererRegistry().registerSuite(
      createPluginIdentity('test.keep-alive-suite', 'runtime'),
      {
        id: 'test.keep-alive-suite', label: 'Keep Alive Suite', apiVersion: 1,
        runtime: { framework: 'solid', version: '1.0.0' },
        compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
        requiredKinds: ['content.unknown'],
        factory: {
          async prepare() {
            return {
              mount(container) {
                mount()
                container.replaceChildren(Object.assign(document.createElement('div'), { textContent: 'keep-alive-suite' }))
                return {
                  update() {}, pause, resume, destroy,
                  on(event, listener) { if (event === 'ready') listener({}); return () => {} },
                }
              },
            }
          },
        },
      },
    )
    try {
      usePresentationPreferenceStore.getState().setRendererSuiteId('modern-gui', 'test.keep-alive-suite')
      const agentId = useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId: 'peri', title: 'Peri' })!
      const overviewId = useWorkspaceStore.getState().openSheet({ kind: 'overview', title: 'Overview' })!
      useWorkspaceStore.getState().focusSheet(agentId)
      const view = render(() => <SheetLayout activeSession={null} onSelectSession={() => {}} onProfileEdit={() => {}} onSessionSettings={() => {}} />)
      await screen.findByText('keep-alive-suite', {}, { timeout: 15_000 })
      expect(getActiveWorkbenchHostPort(agentId)).toBeDefined()

      useWorkspaceStore.getState().focusSheet(overviewId)
      await waitFor(() => expect(pause).toHaveBeenCalledOnce())
      expect(destroy).not.toHaveBeenCalled()

      useWorkspaceStore.getState().focusSheet(agentId)
      await waitFor(() => expect(resume).toHaveBeenCalledOnce())
      expect(mount).toHaveBeenCalledOnce()
      view.unmount()
      expect(getActiveWorkbenchHostPort(agentId)).toBeUndefined()
    } finally {
      await registration.dispose()
    }
  })

  it('右栏作为 flex sibling 时不会再给 Agent renderer 叠加右侧 inset', async () => {
    const mount = vi.fn()
    const registration = getRendererRegistry().registerSuite(
      createPluginIdentity('test.right-panel-inset-suite', 'runtime'),
      {
        id: 'test.right-panel-inset-suite', label: 'Right Panel Inset Suite', apiVersion: 1,
        runtime: { framework: 'solid', version: '1.0.0' },
        compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
        requiredKinds: ['content.unknown'],
        factory: {
          async prepare() {
            return {
              mount(container, input) {
                mount(input)
                container.replaceChildren(Object.assign(document.createElement('div'), { textContent: 'right-panel-inset-suite' }))
                return {
                  update() {}, pause() {}, resume() {}, destroy() {},
                  on(event, listener) { if (event === 'ready') listener({}); return () => {} },
                }
              },
            }
          },
        },
      },
    )
    try {
      usePresentationPreferenceStore.getState().setRendererSuiteId('modern-gui', 'test.right-panel-inset-suite')
      useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId: 'peri', title: 'Peri' })

      render(() => <SheetLayout activeSession={null} onSelectSession={() => {}} onProfileEdit={() => {}} onSessionSettings={() => {}} />)
      await screen.findByText('right-panel-inset-suite', {}, { timeout: 5_000 })

      expect(mount).toHaveBeenCalledWith(expect.objectContaining({ rightInset: 0 }))
    } finally {
      await registration.dispose()
    }
  })
})
