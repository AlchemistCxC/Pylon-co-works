// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import SheetLayout from '../SheetLayout.tsx'
import { resetStores } from '../../test/resetStores.ts'
import { useWorkspaceStore } from '../../workspaceStore.ts'
import { getRendererRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'

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
      render(<SheetLayout activeSession={null} onSelectSession={() => {}} onProfileEdit={() => {}} onSessionSettings={() => {}} rightInset={0} />)
      await screen.findByText('keep-alive-suite', {}, { timeout: 5_000 })

      act(() => useWorkspaceStore.getState().focusSheet(overviewId))
      await waitFor(() => expect(pause).toHaveBeenCalledOnce())
      expect(destroy).not.toHaveBeenCalled()

      act(() => useWorkspaceStore.getState().focusSheet(agentId))
      await waitFor(() => expect(resume).toHaveBeenCalledOnce())
      expect(mount).toHaveBeenCalledOnce()
    } finally {
      await registration.dispose()
    }
  })
})
