/**
 * Typed Clients 行为测试（报告阶段 4 / FE-AUD-008）：
 * command/payload 收口、normalize 后出边界、错误原样上抛（不吞）。
 */
import { describe, expect, it } from 'vitest'
import { FakeInvoke } from '../../../test/fakeInvoke'
import { createAgentClient } from '../agentClient'
import { createSessionClient } from '../sessionClient'
import { createChatClient } from '../chatClient'
import { createRuntimeClient } from '../../tauri/runtimeClient'

describe('agentClient', () => {
  it('listAgents 宽容 normalize（非数组/损坏项/空 id 过滤）', async () => {
    const invoke = new FakeInvoke().register('list_agents', () => [
      { id: 'peri', name: 'Peri' },
      { id: 'serina' },
      { id: '' },
      null,
      'str',
      { name: 'no-id' },
    ])
    const client = createAgentClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const agents = await client.listAgents()
    expect(agents).toEqual([
      { id: 'peri', name: 'Peri' },
      { id: 'serina', name: 'serina' },
    ])
  })

  it('switchAgent 发送 { name } payload', async () => {
    const invoke = new FakeInvoke().register('switch_agent', () => null)
    const client = createAgentClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    await client.switchAgent('peri')
    expect(invoke.calls).toEqual([{ cmd: 'switch_agent', args: { name: 'peri' } }])
  })

  it('agentStatus 发送 agent_status 并原样透传 payload', async () => {
    const payload = { agentId: 'peri', agent: 'Peri', status: 'connected' }
    const invoke = new FakeInvoke().register('agent_status', () => payload)
    const client = createAgentClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    await expect(client.agentStatus()).resolves.toEqual(payload)
    expect(invoke.calls).toEqual([{ cmd: 'agent_status', args: {} }])
  })

  it('错误原样上抛（不吞）', async () => {
    const invoke = new FakeInvoke().register('switch_agent', () => { throw new Error('down') })
    const client = createAgentClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    await expect(client.switchAgent('peri')).rejects.toThrowError('down')
  })
})

describe('sessionClient', () => {
  it('newSession/closeSession payload 收口', async () => {
    const invoke = new FakeInvoke()
    invoke.register('new_session', () => null)
    invoke.register('close_session', () => null)
    const client = createSessionClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    await client.newSession({ source: 'local:一', persona: 'p', cwd: '/w' })
    await client.closeSession('local:一')
    expect(invoke.calls).toEqual([
      { cmd: 'new_session', args: { source: 'local:一', persona: 'p', cwd: '/w' } },
      { cmd: 'close_session', args: { source: 'local:一' } },
    ])
  })

  it('listPersistedSessions 宽容 normalize（损坏项跳过）', async () => {
    const invoke = new FakeInvoke().register('list_persisted_sessions', () => [
      { id: 'a', title: 'A', updatedAt: 300 },
      null,
      { title: 'no-id' },
    ])
    const client = createSessionClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const sessions = await client.listPersistedSessions()
    expect(sessions.length).toBe(1)
    expect(sessions[0]?.id).toBe('a')
  })
})

describe('chatClient', () => {
  it('sendMessage payload 收口（含 attachments）', async () => {
    const invoke = new FakeInvoke().register('send_message', () => null)
    const client = createChatClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    await client.sendMessage({ source: 'local:一', content: 'hi', persona: 'p', sessionPrompt: 'sp', attachments: ['/a.txt'] })
    expect(invoke.calls).toEqual([{
      cmd: 'send_message',
      args: { source: 'local:一', content: 'hi', persona: 'p', sessionPrompt: 'sp', attachments: ['/a.txt'] },
    }])
  })
})

describe('runtimeClient', () => {
  it('listRuntimeLogs normalize 后出边界', async () => {
    const invoke = new FakeInvoke().register('list_runtime_logs', () => [
      { id: 1, level: 'info', message: 'x', timestamp: '2026-01-01' },
      { broken: true },
    ])
    const client = createRuntimeClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const logs = await client.listRuntimeLogs()
    expect(Array.isArray(logs)).toBe(true)
    expect((logs as Array<{ message?: string }>)[0]?.message).toBe('x')
  })
})
