// @vitest-environment jsdom
/**
 * 行为化承接 scripts/test-session-settings-lifecycle.mts：
 * SessionSettings 在 sessionId 或 session 源字段变化时重新同步全部表单字段
 * （name/platform/workdir/sessionPrompt）。原守卫断言 useEffect 订阅 sessionId
 * 与表单源字段的源码 token，这里渲染组件切换会话验证真实行为。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, cleanup, fireEvent, screen } from '@testing-library/react'
import { FakeInvoke } from '../../../test/fakeInvoke'
import { useIdentityStore } from '../../../identityStore'
import SessionSettings from '../../SessionSettings'
import type { Session } from '../../../identityStore'

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeRef.current!(cmd, args),
}))

/** 未注册命令 resolve undefined——表单同步断言不关心后台 invoke */
class TolerantFakeInvoke extends FakeInvoke {
  override invoke(cmd: string, args?: unknown): Promise<unknown> {
    return super.invoke(cmd, args).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Command not found')) return undefined
      throw error
    })
  }
}

let fakeInvoke: TolerantFakeInvoke

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
  fakeInvoke = new TolerantFakeInvoke()
  invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
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

  // 下沉自 scripts/test-session-settings-form.mts（P91 A2）：dirty 门控保存按钮、
  // 信息层级分区（section/danger）、Dialog 说明关联。
  // 注意：SessionSettings 经 Radix Dialog portal 到 body，查询须用 document。
  it('未修改时保存按钮禁用，修改后解锁', async () => {
    useIdentityStore.setState({ sessions: [makeSession('sa', '会话A', '提示A')], sessionsHydrated: true })
    render(<SessionSettings sessionId="sa" open onClose={() => {}} />)
    await waitFor(() => expect(nameInput().value).toBe('会话A'))

    const save = screen.getByRole('button', { name: '保存修改' })
    expect(save).toBeDisabled()
    fireEvent.change(nameInput(), { target: { value: '改名' } })
    expect(save).toBeEnabled()
  })

  it('分区与危险区在 DOM，Dialog 说明经 aria-describedby 关联', async () => {
    useIdentityStore.setState({ sessions: [makeSession('sa', '会话A', '提示A')], sessionsHydrated: true })
    render(<SessionSettings sessionId="sa" open onClose={() => {}} />)
    await waitFor(() => expect(nameInput().value).toBe('会话A'))

    expect(document.querySelector('.session-settings-section')).not.toBeNull()
    expect(document.querySelector('.session-settings-danger')).not.toBeNull()
    expect(document.getElementById('session-settings-description')).not.toBeNull()
    expect(document.querySelector('[aria-describedby="session-settings-description"]')).not.toBeNull()
  })
})
