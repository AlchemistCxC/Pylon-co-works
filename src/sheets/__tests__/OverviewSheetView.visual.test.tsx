// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import OverviewSheetView from '../OverviewSheetView.tsx'
import { useIdentityStore } from '../../identityStore.ts'
import { useRuntimeStore } from '../../runtimeStore.ts'
import { useWorkspaceEntityStore } from '../../workspaceEntityStore.ts'
import { resetStores } from '../../test/resetStores.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }))
vi.mock('../../infrastructure/tauri/env.ts', () => ({ IS_TAURI: false, hasTauriRuntime: () => false }))

const sheet: SheetRecord = { id: 'overview', kind: 'overview', title: 'Overview', createdAt: 0, lastFocusedAt: 0 }

beforeEach(() => {
  resetStores()
  useIdentityStore.setState({
    activeAgent: 'peri',
    agents: [
      { id: 'peri', name: 'Peri', provider: 'ACP' },
      { id: 'hermes', name: 'Hermes', provider: 'ACP' },
    ],
    sessions: [{
      id: 'session-1', agentId: 'peri', periId: 'remote-1', name: '视觉验收会话', source: 'local:visual',
      profileId: 'profile-a', createdAt: 1, lastActiveAt: Date.now(), platform: 'local', workdir: 'G:/Pylon',
      workspaceId: 'workspace-1', sessionPrompt: '', skills: [], hooks: [], autoName: '视觉验收会话',
    }],
  })
  useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', agentId: 'peri', status: 'connected' })
  useRuntimeStore.getState().setAgentStatus('hermes', { agent: 'hermes', agentId: 'hermes', status: 'error' })
  useWorkspaceEntityStore.setState({
    hydrated: true,
    workspaces: [{
      id: 'workspace-1', agentId: 'peri', name: 'Pylon Desktop', rootPath: 'G:/Pylon', createdAt: 1,
      lastActiveAt: Date.now(), skills: [], mcpServerIds: [], hookPluginIds: [],
    }],
  })
})

describe('Overview visual workbench', () => {
  it('projects runtime, session and workspace truth into actionable sections', () => {
    const ctx = { openSheet: vi.fn(), selectSession: vi.fn() } as unknown as SheetContext
    render(<OverviewSheetView sheet={sheet} ctx={ctx} />)

    expect(screen.getByRole('heading', { name: '欢迎回到工作台' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Peri.*1 个会话.*已连接/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Hermes.*0 个会话.*错误/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /视觉验收会话.*Pylon Desktop.*Peri/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Pylon Desktop.*G:\/Pylon.*1 会话/ })).toBeInTheDocument()
  })

  it('opens the existing Agent settings domain from the hero action', () => {
    const listener = vi.fn()
    window.addEventListener('pylon:open-settings', listener)
    render(<OverviewSheetView sheet={sheet} ctx={{} as SheetContext} />)

    fireEvent.click(screen.getByRole('button', { name: 'Agent 设置' }))
    expect(listener).toHaveBeenCalledOnce()
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      domain: 'agents-connections', section: 'agent', agentId: 'peri',
    })
    window.removeEventListener('pylon:open-settings', listener)
  })

  it('内置占位路径不冒充可用 Agent，空工作台优先进入配置', () => {
    useIdentityStore.setState({
      sessions: [],
      agents: [{ id: 'peri', name: 'Peri', provider: 'peri', exe: '<PERI_EXE_PATH>', default: true }],
    })
    const listener = vi.fn()
    window.addEventListener('pylon:open-settings', listener)
    render(<OverviewSheetView sheet={sheet} ctx={{} as SheetContext} />)

    expect(screen.queryByRole('button', { name: /打开 Peri/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /配置 Agent/ }))
    expect(listener).toHaveBeenCalledOnce()
    window.removeEventListener('pylon:open-settings', listener)
  })
})
