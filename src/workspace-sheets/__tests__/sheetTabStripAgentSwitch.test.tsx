// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SheetTabStrip from '../SheetTabStrip'
import { useIdentityStore } from '../../identityStore'
import { resetStores } from '../../test/resetStores'
import type { SheetRecord } from '../sheetTypes'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const sheets: SheetRecord[] = [
  { id: 'peri-sheet', kind: 'agent', title: 'Peri', agentId: 'peri', createdAt: 1, lastFocusedAt: 1 },
  { id: 'hermes-sheet', kind: 'agent', title: 'Hermes', agentId: 'hermes', createdAt: 2, lastFocusedAt: 2 },
]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderStrip(onFocus = vi.fn()) {
  render(
    <SheetTabStrip
      sheets={sheets}
      activeSheetId="peri-sheet"
      activeAgent="peri"
      agentStatuses={{}}
      onFocus={onFocus}
      onClose={vi.fn()}
      menuActions={{
        onTogglePin: vi.fn(),
        onClose: vi.fn(),
        onCloseOthers: vi.fn(),
        onCloseRight: vi.fn(),
        onReopen: vi.fn(),
      }}
      canReopen={false}
    />,
  )
  return onFocus
}

describe('Agent Sheet 聚焦切换事务', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invoke.mockReset()
    Element.prototype.scrollIntoView = vi.fn()
    useIdentityStore.setState({
      agents: [
        { id: 'peri', name: 'Peri' },
        { id: 'hermes', name: 'Hermes' },
      ],
      activeAgent: 'peri',
    })
  })

  it('非 active Agent 必须等 switch 成功后才 focus', async () => {
    const pending = deferred<unknown>()
    invoke.mockReturnValueOnce(pending.promise)
    const onFocus = renderStrip()

    const hermesTab = screen.getByRole('tab', { name: /Hermes/ })
    fireEvent.click(hermesTab)

    expect(invoke).toHaveBeenCalledWith('switch_agent', { name: 'hermes' })
    expect(onFocus).not.toHaveBeenCalled()
    expect(useIdentityStore.getState().activeAgent).toBe('peri')
    expect(hermesTab).toBeDisabled()

    await act(async () => pending.resolve(null))

    await waitFor(() => expect(onFocus).toHaveBeenCalledWith('hermes-sheet'))
    expect(useIdentityStore.getState().activeAgent).toBe('hermes')
  })

  it('switch 失败时不 focus，且保持原 active Agent', async () => {
    invoke.mockRejectedValueOnce(new Error('Hermes 启动失败'))
    const onFocus = renderStrip()

    fireEvent.click(screen.getByRole('tab', { name: /Hermes/ }))

    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(onFocus).not.toHaveBeenCalled()
    expect(useIdentityStore.getState().activeAgent).toBe('peri')
  })

  it('active Agent Sheet 直接 focus，不重复 switch', () => {
    const onFocus = renderStrip()

    fireEvent.click(screen.getByRole('tab', { name: /Peri/ }))

    expect(onFocus).toHaveBeenCalledWith('peri-sheet')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('键盘移动到非 active Agent 同样先 switch 后 focus', async () => {
    const pending = deferred<unknown>()
    invoke.mockReturnValueOnce(pending.promise)
    const onFocus = renderStrip()

    fireEvent.keyDown(screen.getByRole('tab', { name: /Peri/ }), { key: 'ArrowRight' })

    expect(invoke).toHaveBeenCalledWith('switch_agent', { name: 'hermes' })
    expect(onFocus).not.toHaveBeenCalled()

    await act(async () => pending.resolve(null))

    await waitFor(() => expect(onFocus).toHaveBeenCalledWith('hermes-sheet'))
  })
})
