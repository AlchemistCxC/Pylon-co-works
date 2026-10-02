// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * #515：迁移自 fileSheetKeepAlive.integration.test.tsx（React RTL → @solidjs/testing-library）。
 * 改写点登记：
 * - `render(<SheetLayout/>)` → `render(() => <SheetLayout/>)`，实体直连 SheetLayout.solid.tsx；
 * - `act(() => focusSheet(...))` → 直接调用 store action（Solid 无 act；store 通知 →
 *   createZustandSignal 信号 → DOM 落盘为同步）；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开）；
 * - 断言集逐字保留（保活实例同一性 toBe、display:none/contents 切换）。
 */
import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import SheetLayout from '../SheetLayout.solid.tsx'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore.ts'
import { resetStores } from '../../test/resetStores.ts'

// vitest globals 未开，solid testing-library 不自动 cleanup。
afterEach(cleanup)

describe('FileSheet editor keep-alive', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('切换到其他 Sheet 时保留同一个 FileSheet 实例，避免未保存编辑因卸载丢失', () => {
    const fileId = useWorkspaceStore.getState().openSheet({ kind: 'file', title: 'File' })!
    const overviewId = useWorkspaceStore.getState().openSheet({ kind: 'overview', title: 'Overview' })!
    const view = render(() => <SheetLayout activeSession={null} onSelectSession={() => {}} onProfileEdit={() => {}} onSessionSettings={() => {}} />)

    const hiddenInstance = view.container.querySelector(`[data-file-sheet-id="${fileId}"]`)
    expect(hiddenInstance).toBeTruthy()
    expect((hiddenInstance as HTMLElement).style.display).toBe('none')

    useWorkspaceStore.getState().focusSheet(fileId)
    const activeInstance = view.container.querySelector(`[data-file-sheet-id="${fileId}"]`)
    expect(activeInstance).toBe(hiddenInstance)
    expect((activeInstance as HTMLElement).style.display).toBe('contents')

    useWorkspaceStore.getState().focusSheet(overviewId)
    expect(view.container.querySelector(`[data-file-sheet-id="${fileId}"]`)).toBe(hiddenInstance)
  })
})
