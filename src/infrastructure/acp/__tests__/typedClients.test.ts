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
import { normalizeAgentStatus } from '../../../components/settings/agentTypes'

describe('agentClient', () => {
  it('listAgents 宽容 normalize（非数组/损坏项/空 id 过滤）', async () => {
    const invoke = new FakeInvoke().register('list_agents', () => [
      { id: 'peri', name: 'Peri', provider: 'peri', exe: 'F:/peri.exe', default: true, transport: 'subprocess' },
      { id: 'profile-b' },
      { id: '' },
      null,
      'str',
      { name: 'no-id' },
    ])
    const client = createAgentClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const agents = await client.listAgents()
    expect(agents).toEqual([
      { id: 'peri', name: 'Peri', provider: 'peri', exe: 'F:/peri.exe', default: true, transport: 'subprocess', active: undefined, available: undefined, crashed: undefined, cwd: undefined },
      { id: 'profile-b', name: 'profile-b', provider: undefined, exe: undefined, default: undefined, transport: undefined, active: undefined, available: undefined, crashed: undefined, cwd: undefined },
    ])
  })

  it('Agent 结构化配置命令 payload 收口', async () => {
    const invoke = new FakeInvoke()
    let nextRevision = 1
    invoke.register('agent_config_snapshot', () => ({ revision: 'rev-1', agents: [] }))
    invoke.register('update_agents_config', () => ({ revision: `rev-${++nextRevision}` }))
    invoke.register('initialize_agents_config', () => ({ revision: `rev-${++nextRevision}` }))
    invoke.register('test_agent_connection', () => ({ ok: true, agentId: 'peri', durationMs: 1, error: null }))
    const client = createAgentClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    await client.updateAgentFieldPatch('peri', { exe: 'F:/peri.exe' })
    const newAgent = {
      name: 'New: #1',
      provider: 'custom',
      transport: 'subprocess' as const,
      exe: 'C:\\Program Files\\Agent\\agent.exe',
      args: ['acp', '--profile', 'work space'],
      default: false,
    }
    await client.createAgent('new', newAgent)
    const document = { agents: { new: newAgent } }
    await client.initializeAgentsConfig('new', document)
    await client.initializeAgentFieldPatch('hermes', { default: true })
    await client.testAgentConnection('peri')
    expect(invoke.calls).toEqual([
      { cmd: 'agent_config_snapshot', args: {} },
      { cmd: 'update_agents_config', args: { scope: 'agent_fields', agentId: 'peri', config: { exe: 'F:/peri.exe' }, expectedRevision: 'rev-1' } },
      { cmd: 'update_agents_config', args: { scope: 'agent_create', agentId: 'new', config: newAgent, expectedRevision: 'rev-2' } },
      { cmd: 'initialize_agents_config', args: { agentId: 'new', config: document } },
      { cmd: 'initialize_agents_config', args: { agentId: 'hermes', config: { default: true } } },
      { cmd: 'test_agent_connection', args: { agentId: 'peri' } },
    ])
  })

  it('snapshot 故障不得降级为无 revision 盲写', async () => {
    const invoke = new FakeInvoke()
      .register('agent_config_snapshot', () => { throw { code: 'config_read_error', message: 'disk down' } })
      .register('update_agents_config', () => ({ revision: 'unexpected' }))
    const client = createAgentClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })

    await expect(client.updateAgentFieldPatch('peri', { name: 'draft' })).rejects.toMatchObject({ code: 'config_read_error' })
    expect(invoke.calls).toEqual([{ cmd: 'agent_config_snapshot', args: {} }])
  })

  it('switchAgent 发送 { name } payload', async () => {
    const invoke = new FakeInvoke().register('switch_agent', () => null)
    const client = createAgentClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    await client.switchAgent('peri')
    expect(invoke.calls).toEqual([{ cmd: 'switch_agent', args: { name: 'peri' } }])
  })

  it('setSessionState 使用完整 durable owner，remote id 仅作为映射', async () => {
    const invoke = new FakeInvoke().register('set_session_state', () => null)
    const client = createAgentClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const owner = { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:一' }
    await client.setSessionState(owner, { usage: { tokensUsed: 7 } }, 'remote-99')
    expect(invoke.calls).toEqual([{
      cmd: 'set_session_state',
      args: { owner, remoteSessionId: 'remote-99', state: { usage: { tokensUsed: 7 } } },
    }])
  })

  it('agentStatus 发送 agent_status 并原样透传 payload', async () => {
    const payload = { agentId: 'peri', agent: 'Peri', status: 'connected' }
    const invoke = new FakeInvoke().register('agent_status', () => payload)
    const client = createAgentClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    await expect(client.agentStatus()).resolves.toEqual(payload)
    expect(invoke.calls).toEqual([{ cmd: 'agent_status', args: {} }])
  })

  it('wireTraceSnapshot 发送 acp_wire_trace_snapshot 并透传', async () => {
    const payload = { traceId: 'peri-1', length: 0, records: [] }
    const invoke = new FakeInvoke().register('acp_wire_trace_snapshot', () => payload)
    const client = createAgentClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    await expect(client.wireTraceSnapshot()).resolves.toEqual(payload)
    expect(invoke.calls).toEqual([{ cmd: 'acp_wire_trace_snapshot', args: {} }])
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
    await client.newSession({ agentId: 'peri', profileId: 'profile-a', source: 'local:一', persona: 'p', cwd: '/w' })
    await client.closeSession({ agentId: 'peri', source: 'local:一' })
    expect(invoke.calls).toEqual([
      { cmd: 'new_session', args: { agentId: 'peri', profileId: 'profile-a', source: 'local:一', persona: 'p', cwd: '/w' } },
      { cmd: 'close_session', args: { agentId: 'peri', source: 'local:一' } },
    ])
  })

  it('loadPersistedSession 同时携带 profile/agent/local owner 与 remote mapping', async () => {
    const invoke = new FakeInvoke().register('load_persisted_session', () => null)
    const client = createSessionClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const owner = { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:一' }
    await client.loadPersistedSession({
      owner,
      periId: 'remote-99',
    })
    expect(invoke.calls).toEqual([{
      cmd: 'load_persisted_session',
      args: { owner, periId: 'remote-99' },
    }])
  })

  it('loadPersistedSession 保留 replay 完整性与 response boundary', async () => {
    const invoke = new FakeInvoke().register('load_persisted_session', () => ({
      response: { loaded: true },
      replay: [{ update: 2 }, { update: 3 }],
      replayMetadata: {
        complete: false,
        truncated: true,
        droppedCount: 1,
        boundary: {
          kind: 'session-load-response',
          observedCount: 3,
          retainedStartOrdinal: 2,
          retainedEndOrdinal: 3,
        },
      },
      canonicalRevision: 9,
      replayJournalStatus: 'reconciled',
    }))
    const client = createSessionClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const result = await client.loadPersistedSession({
      owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' },
      periId: 'remote-a',
    })

    expect(result.replay).toEqual([{ update: 2 }, { update: 3 }])
    expect(result.replayMetadata).toEqual({
      complete: false,
      truncated: true,
      droppedCount: 1,
      boundary: {
        kind: 'session-load-response',
        observedCount: 3,
        retainedStartOrdinal: 2,
        retainedEndOrdinal: 3,
      },
    })
    expect(result.canonicalRevision).toBe(9)
    expect(result.replayJournalStatus).toBe('reconciled')
  })

  it('缺失 replay metadata 时明确标为不可验证，而非伪装 complete', async () => {
    const invoke = new FakeInvoke().register('load_persisted_session', () => ({
      response: {}, replay: [{ update: 1 }],
    }))
    const client = createSessionClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const result = await client.loadPersistedSession({
      owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' },
      periId: 'remote-a',
    })

    expect(result.replayMetadata).toMatchObject({
      complete: false,
      truncated: false,
      boundary: { kind: 'metadata-unavailable', observedCount: 1 },
    })
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
    await client.sendMessage({ agentId: 'peri', profileId: 'profile-a', source: 'local:一', content: 'hi', persona: 'p', sessionPrompt: 'sp', attachments: ['/a.txt'] })
    expect(invoke.calls).toEqual([{
      cmd: 'send_message',
      args: { agentId: 'peri', profileId: 'profile-a', source: 'local:一', content: 'hi', persona: 'p', sessionPrompt: 'sp', attachments: ['/a.txt'] },
    }])
  })
})

describe('typed status payload：lifecycle 与 capabilities 分字段 normalize，不相互反推', () => {
  it('connected + capabilities null → status 保持 connected，capabilities 原样为 null', () => {
    const normalized = normalizeAgentStatus({ agentId: 'peri', status: 'connected', capabilities: null }, 'peri')
    expect(normalized.status).toBe('connected')
    expect(normalized.capabilities).toBeNull()
  })

  it('非 connected 携带 capabilities 对象 → status 不被 capabilities 反推为 connected', () => {
    const normalized = normalizeAgentStatus({
      agentId: 'peri',
      status: 'reconnecting',
      capabilities: { promptCapabilities: { image: true } },
    }, 'peri')
    expect(normalized.status).toBe('reconnecting')
    expect(normalized.capabilities).toEqual({ promptCapabilities: { image: true } })
  })

  it('缺失 status → 归 unknown（非 connected），capabilities 缺失为 undefined', () => {
    const normalized = normalizeAgentStatus({ agentId: 'peri' }, 'peri')
    expect(normalized.status).toBe('unknown')
    expect(normalized.capabilities).toBeUndefined()
  })

  it('非法 status 字符串 → 归 error 并带诊断，capabilities 原样保留', () => {
    const normalized = normalizeAgentStatus({
      agentId: 'peri',
      status: 'bogus-status',
      capabilities: { promptImage: true },
    }, 'peri')
    expect(normalized.status).toBe('error')
    expect(normalized.recentError).toMatch(/未知 Agent 状态/)
    expect(normalized.capabilities).toEqual({ promptImage: true })
  })

  it('crashed 派生路径同样保留 capabilities，不改变生命周期语义', () => {
    const normalized = normalizeAgentStatus({ agentId: 'peri', crashed: true, capabilities: null }, 'peri')
    expect(normalized.status).toBe('crashed')
    expect(normalized.capabilities).toBeNull()
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
