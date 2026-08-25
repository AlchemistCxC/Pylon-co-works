// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import SheetLayout from '../SheetLayout.tsx'
import { useWorkspaceStore } from '../../workspaceStore.ts'
import { resetStores } from '../../test/resetStores.ts'

describe('FileSheet editor keep-alive', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('切换到其他 Sheet 时保留同一个 FileSheet 实例，避免未保存编辑因卸载丢失', () => {
    const fileId = useWorkspaceStore.getState().openSheet({ kind: 'file', title: 'File' })!
    const overviewId = useWorkspaceStore.getState().openSheet({ kind: 'overview', title: 'Overview' })!
    const view = render(<SheetLayout activeSession={null} onSelectSession={() => {}} onProfileEdit={() => {}} onSessionSettings={() => {}} />)

    const hiddenInstance = view.container.querySelector(`[data-file-sheet-id="${fileId}"]`)
    expect(hiddenInstance).toBeTruthy()
    expect((hiddenInstance as HTMLElement).style.display).toBe('none')

    act(() => useWorkspaceStore.getState().focusSheet(fileId))
    const activeInstance = view.container.querySelector(`[data-file-sheet-id="${fileId}"]`)
    expect(activeInstance).toBe(hiddenInstance)
    expect((activeInstance as HTMLElement).style.display).toBe('contents')

    act(() => useWorkspaceStore.getState().focusSheet(overviewId))
    expect(view.container.querySelector(`[data-file-sheet-id="${fileId}"]`)).toBe(hiddenInstance)
  })
})
