/**
 * TS-WI02 RED：生产 UI 必须暴露 unresolved，会话可选 owner，取消不改现场。
 */
// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SessionOwnerRecoveryDialog from '../SessionOwnerRecoveryDialog'
import { useIdentityStore } from '../../identityStore'
import { resetStores } from '../../test/resetStores'
import type { LegacySession } from '../../sessionPersistence'

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
    render(<SessionOwnerRecoveryDialog />)

    expect(screen.getByRole('dialog', { name: '恢复遗留会话归属' })).toBeInTheDocument()
    expect(screen.getByText('遗留会话')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('combobox', { name: '遗留会话的 Agent' }))
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Profile B' }))
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }))

    await waitFor(() => expect(resolveSessionOwner).toHaveBeenCalledWith('legacy-1', 'profile-b'))
  })

  it('取消只隐藏当前提示，不修改 unresolved', () => {
    render(<SessionOwnerRecoveryDialog />)
    fireEvent.click(screen.getByRole('button', { name: '稍后处理' }))
    expect(screen.queryByRole('dialog', { name: '恢复遗留会话归属' })).not.toBeInTheDocument()
    expect(useIdentityStore.getState().sessionHydration).toEqual({ kind: 'needs-owner-resolution', unresolved: [legacy] })

    act(() => {
      useIdentityStore.setState({ sessionHydration: { kind: 'needs-owner-resolution', unresolved: [...[legacy], { ...legacy, id: 'legacy-2' }] } })
    })
    expect(screen.getByRole('dialog', { name: '恢复遗留会话归属' })).toBeInTheDocument()
  })
})
