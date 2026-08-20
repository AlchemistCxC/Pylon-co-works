// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

const listeners = new Map<string, (payload: unknown) => void>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, payload => handler({ payload }))
    return Promise.resolve(() => listeners.delete(event))
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }))

import { attachChatEventController, type ChatEventControllerRefs } from '../chatEventController'
import { useIdentityStore, type Session } from '../../../identityStore'
import { invoke } from '@tauri-apps/api/core'

function refs(): ChatEventControllerRefs {
  return {
    sessionRef: { current: null },
    messageOwnerRef: { current: null },
    setMessages: () => {},
    setStreamingText: () => {},
    setStreamingThinking: () => {},
    setGenerating: () => {},
    setGenerationPhase: () => {},
    setSummary: () => {},
    setLastTokenAt: () => {},
  }
}

function session(source: string): Session {
  return {
    id: 'session-wire-shape', agentId: 'peri', periId: 'remote-wire', source, name: 'session', profileId: 'profile',
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '.', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function replay(update: Record<string, unknown>): unknown {
  return { sessionId: 'peri-session', update: { ...update, _meta: { periReplay: true } } }
}

describe('真实 replay wire 工具字段兼容', () => {
  it('tool_call/update 使用嵌套 content.toolCallId 时仍恢复为单张工具卡', async () => {
    const source = 'local:wire-tool'
    useIdentityStore.setState({ sessions: [session(source)] })
    const handle = attachChatEventController(refs())
    await new Promise(resolve => setTimeout(resolve, 20))
    handle.initSource(source, [])

    const gen = handle.beginLoadLock(source)
    handle.commitReplaySnapshot(source, gen, [
      replay({ sessionUpdate: 'tool_call', title: 'Read', kind: 'read_file', content: { toolCallId: 'nested-1' }, rawInput: { path: 'a.txt' } }),
      replay({ sessionUpdate: 'tool_call_update', kind: 'read_file', content: { toolCallId: 'nested-1' }, rawOutput: '内容', status: 'completed' }),
    ])
    handle.finishLoadLock(source, gen)

    const tools = handle.getMessages(source).filter(message => message.role === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ id: 'tool-nested-1', toolName: 'Read', toolOutput: '内容', toolStatus: 'completed' })
    handle.dispose()
  })

  it('live 路径经统一 resolveToolCallId 解析 legacy 别名（toolUseId，§5.11 单一路径）', async () => {
    const source = 'local:wire-live-alias'
    useIdentityStore.setState({ sessions: [session(source)] })
    const handle = attachChatEventController(refs())
    await new Promise(resolve => setTimeout(resolve, 20))
    handle.initSource(source, [])

    const liveUpdate = listeners.get('pylon:update')
    expect(liveUpdate).toBeDefined()
    liveUpdate!({
      source,
      update: { sessionUpdate: 'tool_call', toolUseId: 'legacy-live-1', title: 'Read', kind: 'read_file' },
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    const tools = handle.getMessages(source).filter(message => message.role === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0].id).toBe('tool-legacy-live-1')
    handle.dispose()
  })

  it('live usage 状态写入完整 durable owner，不再用 source/periId 互换', async () => {
    vi.mocked(invoke).mockClear()
    const source = 'local:wire-state-owner'
    useIdentityStore.setState({ sessions: [session(source)] })
    const handle = attachChatEventController(refs())
    await new Promise(resolve => setTimeout(resolve, 20))
    handle.initSource(source, [])

    listeners.get('pylon:update')!({
      source,
      update: { sessionUpdate: 'usage_update', used: 7, size: 100 },
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    const stateCall = vi.mocked(invoke).mock.calls.find(call => call[0] === 'set_session_state')
    expect(stateCall).toEqual(['set_session_state', {
      owner: { profileId: 'profile', agentId: 'peri', localSessionId: source },
      remoteSessionId: 'remote-wire',
      state: { usage: { tokensUsed: 7, tokensMax: 100, cacheReadTokens: 0 } },
    }])
    handle.dispose()
  })

  it('load 失败后保持 detached 发送锁，只有显式 retry/fork attempt 才解除', async () => {
    const source = 'local:detached-load'
    useIdentityStore.setState({ sessions: [session(source)] })
    const handle = attachChatEventController(refs())
    await new Promise(resolve => setTimeout(resolve, 20))
    handle.initSource(source, [])

    const failedGeneration = handle.beginLoadLock(source)
    handle.abortSessionLoad(source, failedGeneration)
    expect(handle.isSendBlockedDuringLoad(source)).toBe(true)

    const retryGeneration = handle.beginLoadLock(source)
    expect(handle.isSendBlockedDuringLoad(source)).toBe(true)
    handle.finishLoadLock(source, retryGeneration)
    expect(handle.isSendBlockedDuringLoad(source)).toBe(false)
    handle.dispose()
  })
})
