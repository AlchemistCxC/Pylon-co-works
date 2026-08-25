import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { resetStores } from '../../test/resetStores.ts'
import { useWorkspaceStore } from '../../workspaceStore.ts'
import { closeWorkspace } from '../workspaceController.ts'
import { registerWorkspaceLiveCloseGuard } from '../workspaceLiveCloseGuards.ts'

describe('workspace live close guard', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('live editor 拒绝关闭时保留 Sheet，解除 guard 后可关闭', async () => {
    const id = useWorkspaceStore.getState().openSheet({ kind: 'file', title: 'File' })!
    const guard = vi.fn(() => false)
    const unregister = registerWorkspaceLiveCloseGuard(id, guard)

    expect(await closeWorkspace(id)).toBe(false)
    expect(guard).toHaveBeenCalledOnce()
    expect(useWorkspaceStore.getState().workspaceSheets.sheets.some(sheet => sheet.id === id)).toBe(true)

    unregister()
    expect(await closeWorkspace(id)).toBe(true)
  })
})
