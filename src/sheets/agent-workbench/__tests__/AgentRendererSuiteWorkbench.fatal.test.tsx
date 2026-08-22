// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes.ts'
import { activateBuiltinPlugin, getPluginRuntime } from '../../../plugin-runtime/pluginCompositionRoot.ts'
import { resetStores } from '../../../test/resetStores.ts'
import AgentSheetView from '../../AgentSheetView.tsx'

vi.mock('../../../renderers/solid-workbench/loadSolidWorkbench.ts', () => ({
  loadSolidWorkbench: vi.fn(async () => { throw new Error('builtin solid prepare failed') }),
}))

const ctx: SheetContext = {
  openSheet: () => null, focusSheet: () => {}, closeSheet: () => {},
  activeSession: null, selectSession: () => {}, openProfileEdit: () => {}, openSessionSettings: () => {},
  sidebarCollapsed: false, rightInset: 0, ccEditMode: false,
  sessionSource: () => null, sessionBySource: () => undefined,
}
const sheet: SheetRecord = {
  id: 'agent-fatal', kind: 'agent', title: 'Agent', agentId: 'peri', createdAt: 1, lastFocusedAt: 1,
  state: { sidebarMode: 'work' },
}

beforeAll(async () => {
  await activateBuiltinPlugin('builtin.pylon-renderers')
})

afterAll(async () => {
  const active = getPluginRuntime().snapshot().active.find(item => item.pluginId === 'builtin.pylon-renderers')
  if (active) await getPluginRuntime().deactivate(active.key)
})

describe('Agent Workbench builtin Solid fatal recovery', () => {
  beforeEach(resetStores)

  it('最终显示读取同一 document 的 React fallback，手动重试不改 journal revision', async () => {
    render(<AgentSheetView sheet={sheet} ctx={ctx} />)
    const fallback = await screen.findByLabelText('React Workbench fatal fallback', {}, { timeout: 5_000 })
    expect(fallback).toHaveAttribute('data-suite-id', 'builtin.solid')
    expect(fallback).toHaveAttribute('data-document-revision', '0')

    fireEvent.click(screen.getByRole('button', { name: '重试 Solid' }))

    await waitFor(() => expect(screen.getByLabelText('React Workbench fatal fallback')).toHaveAttribute('data-document-revision', '0'))
  })
})
