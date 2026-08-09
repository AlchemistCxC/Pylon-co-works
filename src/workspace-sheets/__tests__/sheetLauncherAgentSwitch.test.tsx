// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SheetLauncher from '../SheetLauncher'
import { useIdentityStore } from '../../identityStore'
import { resetStores } from '../../test/resetStores'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('SheetLauncher Agent 激活事务', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invoke.mockReset()
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Element.prototype.scrollIntoView = vi.fn()
    useIdentityStore.setState({ activeAgent: 'peri' })
  })

  it('选择非 active Agent 时等 switch 成功后才打开 Sheet', async () => {
    const pending = deferred<unknown>()
    invoke.mockReturnValueOnce(pending.promise)
    const onOpenSheet = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <SheetLauncher
        open
        agents={[{ id: 'peri', name: 'Peri' }, { id: 'hermes', name: 'Hermes' }]}
        sheets={[]}
        onOpenChange={onOpenChange}
        onFocusSheet={vi.fn()}
        onOpenSheet={onOpenSheet}
        onOpenSettings={vi.fn()}
        onOpenProfiles={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('option', { name: 'agentHermeshermes' }))

    expect(invoke).toHaveBeenCalledWith('switch_agent', { name: 'hermes' })
    expect(onOpenSheet).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    await act(async () => pending.resolve(null))

    await waitFor(() => expect(onOpenSheet).toHaveBeenCalledWith('agent', 'Hermes', 'hermes'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
