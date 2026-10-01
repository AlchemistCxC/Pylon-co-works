/**
 * TS-WI02 RED：生产 UI 必须暴露 unresolved，会话可选 owner，取消不改现场。
 * #515：迁移自 SessionOwnerRecoveryDialog.test.tsx（React RTL → Solid 实体直连；
 * 断言集原样保留；React act 包装随框架退役）。
 */
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionOwnerRecoveryDialog from '../SessionOwnerRecoveryDialog.solid.tsx'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { resetStores } from '../../test/resetStores'
import type { LegacySession } from '../../domains/identity/sessionPersistence'

const legacy: LegacySession = {
  id: 'legacy-1', name: '遗留会话', source: 'qq:group:1', profileId: 'profile-a', createdAt: 1,
  lastActiveAt: 2, platform: 'qq', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '',
}

describe('TS-WI02 SessionOwnerRecoveryDialog', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useIdentityStore.setState({
      agents: [{ id: 'peri', name: 'Peri' }, { id: 'profile-b', name: 'Profile B' }],
      sessionHydration: { kind: 'needs-owner-resolution', unresolved: [legacy] },
      sessionsHydrated: true,
    })
  })

  afterEach(async () => {
    const { cleanup } = await import('@solidjs/testing-library')
    cleanup()
  })

  it('显示未决会话，选择 owner 后调用恢复 action', async () => {
    const resolveSessionOwner = vi.fn(async (sessionId: string, agentId: string) => {
      const state = useIdentityStore.getState()
      const current = state.sessionHydration
      if (current?.kind !== 'needs-owner-resolution') return false
      const item = current.unresolved.find(session => session.id === sessionId)
      if (!item) return false
      useIdentityStore.setState({
        sessions: [...state.sessions, { ...item, agentId }],
        sessionHydration: { kind: 'ready' },
      })
      return true
    })
    useIdentityStore.setState({ resolveSessionOwner })
    render(() => <SessionOwnerRecoveryDialog />)

    expect(screen.getByRole('dialog', { name: '恢复遗留会话归属' })).toBeInTheDocument()
    expect(screen.getByText('遗留会话')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('combobox', { name: '遗留会话的 Agent' }))
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Profile B' }))
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }))

    await waitFor(() => expect(resolveSessionOwner).toHaveBeenCalledWith('legacy-1', 'profile-b'))
  })

  it('取消只隐藏当前提示，不修改 unresolved', async () => {
    render(() => <SessionOwnerRecoveryDialog />)
    fireEvent.click(screen.getByRole('button', { name: '稍后处理' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '恢复遗留会话归属' })).not.toBeInTheDocument())
    expect(useIdentityStore.getState().sessionHydration).toEqual({ kind: 'needs-owner-resolution', unresolved: [legacy] })

    useIdentityStore.setState({ sessionHydration: { kind: 'needs-owner-resolution', unresolved: [...[legacy], { ...legacy, id: 'legacy-2' }] } })
    await waitFor(() => expect(screen.getByRole('dialog', { name: '恢复遗留会话归属' })).toBeInTheDocument())
  })
})
