// @vitest-environment jsdom
/**
 * OWNER-03 InputBar Binding gate（方案书 §5.9）：
 * Sheet 恢复 ≠ Agent 已连——binding 非 binding_ready 时 textarea/发送禁用，
 * 并显示 owner Agent 状态；Agent connected → binding_ready → 解锁。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import InputBar from '../InputBar'
import { useIdentityStore } from '../../../identityStore'
import { useRuntimeStore } from '../../../runtimeStore'
import { useWorkspaceStore } from '../../../workspaceStore'
import { useStore } from '../../../store'
import { createSheetState } from '../../../workspace-sheets/sheetState'
import { resetStores } from '../../../test/resetStores'
import { sessionContext, toAgentContextKey } from '../../../agentContext'
import type { Session } from '../../../identityStore'
import { registerChatController, type ChatControllerHandle } from '../chatEventController'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  listen: () => Promise.resolve(() => {}),
}))

class MockResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView = () => {}

const SESSION: Session = {
  id: 's1', agentId: 'peri', name: 'Demo', source: 'local:demo', profileId: 'profile-a',
  createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
  skills: [], hooks: [], autoName: '',
}

function seedAgentSheet(): void {
  // composer 变体确保 send 按钮渲染（默认态可能是 cli，按钮隐藏）
  useStore.setState({ inputMode: 'composer', inputVariant: 'composer' })
  useWorkspaceStore.setState({
    workspaceSheets: createSheetState([
      { id: 'sheet-peri', kind: 'agent', agentId: 'peri', title: 'Peri', createdAt: 1, lastFocusedAt: 1 },
    ], 'sheet-peri', []),
  })
  useIdentityStore.setState({
    sessions: [SESSION],
    agents: [{ id: 'peri', name: 'Peri' }],
    activeAgent: 'peri',
    profiles: [{ id: 'profile-a', name: 'R', persona: 'p', model: 'm' }],
    activeProfileId: 'profile-a',
  })
}

describe('InputBar Binding gate（OWNER-03）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
    registerChatController(null)
  })

  it('冷启动状态缺失 → restoring：textarea/发送禁用 + owner 状态显示', () => {
    seedAgentSheet()
    render(<InputBar sessionId="s1" />)
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('等待 Agent peri 连接')
  })

  it('Agent connected → binding_ready：发送可用 + 状态消失', () => {
    seedAgentSheet()
    useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', agentId: 'peri', status: 'connected', generation: 1 })
    render(<InputBar sessionId="s1" />)
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('新消息')).toBeTruthy()
    expect(screen.getByText(/Enter 发送/)).toBeTruthy()
  })

  it('Sheet 归属与会话归属不一致 → restore_error：禁用 + 错误文案（不猜测）', () => {
    seedAgentSheet()
    // 会话被改归 hermes，而激活 sheet 归属 peri → 引用不一致
    useIdentityStore.setState({ sessions: [{ ...SESSION, agentId: 'hermes' }] })
    render(<InputBar sessionId="s1" />)
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('绑定恢复失败')
  })

  it('Agent disconnected（终态）→ agent_disconnected：禁用 + 未连接文案', () => {
    seedAgentSheet()
    useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', agentId: 'peri', status: 'disconnected', generation: 1 })
    render(<InputBar sessionId="s1" />)
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('未连接')
  })
})

describe('InputBar Binding gate：generation 失效（OWNER-04）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
  })

  it('binding 建立于 gen 5 → 重连 gen 6 → binding_stale：禁用 + “已重连”文案（不发送旧 remote id）', () => {
    seedAgentSheet()
    useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', agentId: 'peri', status: 'connected', generation: 5 })
    useRuntimeStore.getState().setBindingGeneration(sessionContext({ agentId: 'peri', source: SESSION.source }), 5)
    // 后端重启/替换 → generation 单调递增（shouldAcceptAgentStatus 门控放行 5→6）
    useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', agentId: 'peri', status: 'connected', generation: 6 })
    render(<InputBar sessionId="s1" />)
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('已重连')
    expect(screen.getByRole('status').textContent).toContain('需重新加载会话')
  })

  it('绑定重建后（established === current）→ 恢复 binding_ready：解锁', () => {
    seedAgentSheet()
    useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', agentId: 'peri', status: 'connected', generation: 5 })
    useRuntimeStore.getState().setBindingGeneration(sessionContext({ agentId: 'peri', source: SESSION.source }), 5)
    render(<InputBar sessionId="s1" />)
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('continuity probe detached：锁定发送并由用户显式重新连接会话', () => {
    seedAgentSheet()
    const context = sessionContext({ agentId: 'peri', source: SESSION.source })
    useRuntimeStore.getState().setBindingGeneration(context, 5)
    useRuntimeStore.getState().setAgentStatus('peri', {
      agent: 'peri', agentId: 'peri', status: 'connected', generation: 6,
      sessionBindings: [{ agentId: 'peri', source: SESSION.source, health: 'detached', generation: 6, reason: 'session-probe-timeout', retryable: true }],
    })
    render(<InputBar sessionId="s1" />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('请重新连接会话')
    fireEvent.click(screen.getByRole('button', { name: '重新连接会话' }))
    expect(useRuntimeStore.getState().sessionReloadTokens[toAgentContextKey(context)]).toBe(1)
    expect(invokeMock).not.toHaveBeenCalledWith('new_session', expect.anything())
  })

  it('CR-1 queue 发送路径受 binding 守卫：binding_stale 时 queue 按钮禁用，load-finished 自动 flush 不触发 send_message', () => {
    seedAgentSheet()
    useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', agentId: 'peri', status: 'connected', generation: 5 })
    useRuntimeStore.getState().setBindingGeneration(sessionContext({ agentId: 'peri', source: SESSION.source }), 5)
    render(<InputBar sessionId="s1" />)
    // 生成中排队一条消息（用户典型路径：generating 时 Enter → send() → enqueue）
    act(() => {
      useRuntimeStore.setState({ liveGenerating: SESSION.source, liveGeneratingSources: [SESSION.source] })
    })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'queue-send' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(screen.getByLabelText('待发送消息').textContent).toContain('queue-send')
    // 生成结束，但后端重启/替换 → generation 递增 → binding_stale（旧 binding 已失效）
    act(() => {
      useRuntimeStore.setState({ liveGenerating: null, liveGeneratingSources: [] })
      useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', agentId: 'peri', status: 'connected', generation: 6 })
    })
    // queue 发送按钮并入 binding 守卫：禁用 + stale 提示
    const queueSend = screen.getByRole('button', { name: '发送待发送消息' }) as HTMLButtonElement
    expect(queueSend.disabled).toBe(true)
    expect(queueSend.title).toContain('已重连')
    // load-finished 自动 flush 同样受 sendText 层守卫：不得携带旧 remote id 发送
    window.dispatchEvent(new CustomEvent('pylon:load-finished', { detail: { source: SESSION.source } }))
    expect(invokeMock).not.toHaveBeenCalledWith('send_message', expect.anything())
  })
})

describe('InputBar optimistic user settlement（C0-OPT）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'send_message') throw new Error('transport failed')
      return undefined
    })
    registerChatController(null)
  })

  it('显式 runtime-local optimistic user，并在 transport reject 时对称撤销', async () => {
    seedAgentSheet()
    useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', agentId: 'peri', status: 'connected', generation: 1 })
    useRuntimeStore.getState().setBindingGeneration(sessionContext({ agentId: 'peri', source: SESSION.source }), 1)
    const optimistic = vi.fn()
    const reject = vi.fn()
    registerChatController({
      isSendBlockedDuringLoad: () => false,
      sendOptimisticUser: optimistic,
      rejectOptimisticUser: reject,
    } as unknown as ChatControllerHandle)

    render(<InputBar sessionId="s1" />)
    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'hello' } })
    fireEvent.keyDown(textbox, { key: 'Enter' })

    await waitFor(() => expect(optimistic).toHaveBeenCalledTimes(1))
    const [source, content, clientMessageId, options] = optimistic.mock.calls[0]
    expect({ source, content, options }).toEqual({
      source: SESSION.source,
      content: 'hello',
      options: { persistCanonical: false },
    })
    await waitFor(() => expect(reject).toHaveBeenCalledWith(source, clientMessageId))
  })
})
