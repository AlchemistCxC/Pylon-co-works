// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * SheetLauncher Agent 激活事务：选择非 active Agent 时等 switch 成功后才打开 Sheet。
 *
 * #515：迁移自 sheetLauncherAgentSwitch.test.tsx（React RTL → @solidjs/testing-library，
 * 实体直连 SheetLauncher.solid.tsx）。改写点登记：
 * - 实体 props 形态是 `latest: () => SheetLauncherProps` 访问器隧道（照 App.solid.tsx 用法）；
 * - Solid 无 act：pending.resolve 后直接 `waitFor` 断言（事务链经 Promise 微任务
 *   推进，waitFor 轮询 DOM/闭包即可见）；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开）；
 * - 断言集逐字保留（switch_agent invoke 参数、成功前不开 sheet、成功后开 agent sheet
 *   并关闭 launcher）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SheetLauncher from '../SheetLauncher.solid.tsx'
import type { SheetLauncherProps } from '../SheetLauncher.solid.tsx'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { resetStores } from '../../test/resetStores'

afterEach(cleanup)

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function launcherProps(overrides?: Partial<SheetLauncherProps>): SheetLauncherProps {
  return {
    open: true,
    agents: [],
    sheets: [],
    onOpenChange: vi.fn(),
    onFocusSheet: vi.fn(),
    onOpenSheet: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenProfiles: vi.fn(),
    ...overrides,
  }
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
    render(() => <SheetLauncher latest={() => launcherProps({
      agents: [{ id: 'peri', name: 'Peri' }, { id: 'hermes', name: 'Hermes' }],
      onOpenChange,
      onOpenSheet,
    })} />)

    fireEvent.click(screen.getByRole('option', { name: /Hermes.*hermes/ }))

    expect(invoke).toHaveBeenCalledWith('switch_agent', { name: 'hermes' })
    expect(onOpenSheet).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    pending.resolve(null)

    await waitFor(() => expect(onOpenSheet).toHaveBeenCalledWith('agent', 'Hermes', 'hermes'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
