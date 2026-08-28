// @vitest-environment jsdom
/**
 * 行为化承接 scripts/test-session-settings-lifecycle.mts：
 * SessionSettings 在 sessionId 或 session 源字段变化时重新同步全部表单字段
 * （name/platform/workdir/sessionPrompt）。原守卫断言 useEffect 订阅 sessionId
 * 与表单源字段的源码 token，这里渲染组件切换会话验证真实行为。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'
import { useIdentityStore } from '../../../identityStore'
import SessionSettings from '../../SessionSettings'
import type { Session } from '../../../identityStore'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))

function makeSession(id: string, name: string, sessionPrompt: string): Session {
  return {
    id, agentId: 'peri', source: `local:${id}`, name, profileId: 'p1', createdAt: 1, lastActiveAt: 1,
    platform: 'local', workdir: '/wd', sessionPrompt, skills: [], hooks: [], autoName: '',
  }
}

function nameInput(): HTMLInputElement {
  return document.getElementById('session-name') as HTMLInputElement
}

beforeEach(() => {
  invokeMock.mockReset()
  useIdentityStore.setState({ sessions: [], sessionsHydrated: true })
  localStorage.clear()
})

afterEach(() => { cleanup() })

describe('SessionSettings 表单同步（session-settings-lifecycle 契约）', () => {
  it('会话切换时名称字段重置为新会话值', async () => {
    useIdentityStore.setState({ sessions: [makeSession('sa', '会话A', '提示A'), makeSession('sb', '会话B', '提示B')], sessionsHydrated: true })

    const { rerender } = render(<SessionSettings sessionId="sa" open onClose={() => {}} />)
    await waitFor(() => expect(nameInput().value).toBe('会话A'))

    rerender(<SessionSettings sessionId="sb" open onClose={() => {}} />)
    await waitFor(() => expect(nameInput().value).toBe('会话B'))
  })

  it('会话不存在时不渲染表单（保守返回 null）', () => {
    useIdentityStore.setState({ sessions: [makeSession('sa', '会话A', '提示A')], sessionsHydrated: true })
    const { container } = render(<SessionSettings sessionId="missing" open onClose={() => {}} />)
    // 无 session 时组件 return null，不渲染表单（也说明不存在"清空缺省值"路径）
    expect(nameInput()).toBeNull()
    expect(container.querySelector('.session-settings-section')).toBeNull()
  })

  it('会话名称变化（同 id 改名）→ 表单跟随', async () => {
    const a = makeSession('sa', '旧名', '旧提示')
    useIdentityStore.setState({ sessions: [a], sessionsHydrated: true })
    render(<SessionSettings sessionId="sa" open onClose={() => {}} />)
    await waitFor(() => expect(nameInput().value).toBe('旧名'))

    useIdentityStore.setState({ sessions: [{ ...a, name: '新名', sessionPrompt: '新提示' }], sessionsHydrated: true })
    await waitFor(() => expect(nameInput().value).toBe('新名'))
  })
})
