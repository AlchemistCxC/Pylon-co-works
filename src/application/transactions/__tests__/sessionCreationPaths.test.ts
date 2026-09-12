import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../../../identityStore.ts'
import { createAgentWorkbenchSession } from '../../../sheets/agent-workbench/agentWorkbenchSessionCreation.ts'
import { AgentWorkbenchLifecycle } from '../../../sheets/agent-workbench/agentWorkbenchLifecycle.ts'
import { createCliSessionControlPort } from '../../../cli/pylonCliDomainPorts.ts'

const mocks = vi.hoisted(() => ({
  identity: vi.fn(), runtime: vi.fn(), preflight: vi.fn(), invoke: vi.fn(),
  hook: vi.fn(), boundary: vi.fn(), apply: vi.fn(), report: vi.fn(),
}))
vi.mock('../../../identityStore.ts', () => ({ useIdentityStore: { getState: mocks.identity } }))
vi.mock('../../../runtimeStore.ts', () => ({ useRuntimeStore: { getState: mocks.runtime } }))
vi.mock('../../../workspaceEntityStore.ts', () => ({ useWorkspaceEntityStore: { getState: () => ({ workspaces: [] }) } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../../../plugins/core/sessionCreation/sessionPreflight.ts', () => ({ runSessionPreflight: mocks.preflight }))
vi.mock('../../../plugin-runtime/runtimeServices.ts', () => ({ getHookRuntime: () => ({ invoke: mocks.hook }) }))
vi.mock('../../../application/transactions/sessionHookTransactions.ts', () => ({ runSessionBoundaryHook: mocks.boundary }))
vi.mock('../../../components/chat/hookRuntime.ts', () => ({ runSessionBoundaryHook: mocks.boundary }))
vi.mock('../../../domains/sessionState/sessionStateSync.ts', () => ({ applySessionStateResponse: mocks.apply }))
vi.mock('../../../runtimeError.ts', () => ({ reportRuntimeError: mocks.report, resolveRuntimeErrors: vi.fn() }))
vi.mock('../../../infrastructure/tauri/env.ts', () => ({ IS_TAURI: true, isBrowserMockRuntime: () => false }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const session: Session = {
  id: 'local-id', agentId: 'owner', profileId: 'profile', source: 'local:source',
  name: 'title', createdAt: 1, lastActiveAt: 1, platform: 'local',
  workdir: '/workspace', workspaceId: 'workspace', sessionPrompt: '', skills: [], hooks: [], autoName: '',
}
const profile = { id: 'profile', name: 'profile', persona: 'persona', model: 'model' }
const identity = {
  sessions: [session], profiles: [profile], activeAgent: 'unrelated-agent',
  addSession: vi.fn(() => session.id), setSessionPeriId: vi.fn(), removeSession: vi.fn(),
}
const runtime = { agentStatuses: { owner: { generation: 7 } }, setBindingGeneration: vi.fn() }
const paths = ['workbench', 'cli', 'recovery'] as const
type Path = typeof paths[number]
function create(path: Path, signal = new AbortController().signal, isCurrent = () => true) {
  if (path === 'workbench') return createAgentWorkbenchSession(undefined, { agentId: session.agentId, workspaceMode: 'chat' })
  if (path === 'cli') return createCliSessionControlPort().create({ agentId: session.agentId }, { signal })
  return new AgentWorkbenchLifecycle().activate(session, { isCurrent })
}

beforeEach(() => {
  vi.clearAllMocks()
  identity.profiles = [profile]
  mocks.identity.mockReturnValue(identity)
  mocks.runtime.mockReturnValue(runtime)
  mocks.hook.mockImplementation(async (_phase, event) => ({ action: 'continue', event }))
  mocks.preflight.mockResolvedValue({ mcpServers: [{ name: 'mcp' }] })
  mocks.invoke.mockResolvedValue({ sessionId: 'remote', configOptions: [] })
})

describe.each(paths)('%s session creation contract', path => {
  it('waits for preflight, uses the session owner, then commits the remote binding', async () => {
    const gate = deferred<{ mcpServers: unknown[] }>()
    mocks.preflight.mockReturnValue(gate.promise)
    const pending = create(path)
    await vi.waitFor(() => expect(mocks.preflight).toHaveBeenCalledTimes(1))
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(identity.setSessionPeriId).not.toHaveBeenCalled()
    gate.resolve({ mcpServers: [{ name: 'mcp' }] })
    await pending
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('new_session', {
      agentId: 'owner', profileId: 'profile', source: 'local:source',
      cwd: '/workspace', workspaceId: 'workspace', persona: 'persona', model: 'model',
      mcpServers: [{ name: 'mcp' }],
    })
    expect(identity.setSessionPeriId).toHaveBeenCalledExactlyOnceWith('local-id', 'remote')
    if (path !== 'cli') expect(runtime.setBindingGeneration).toHaveBeenCalledWith({ agentId: 'owner', source: 'local:source' }, 7)
    else expect(mocks.apply).not.toHaveBeenCalled()
  })

  it('preserves profile snapshot timing across asynchronous preflight', async () => {
    mocks.preflight.mockImplementation(async () => {
      identity.profiles = [{ ...profile, persona: 'changed-persona', model: 'changed-model' }]
      return { mcpServers: [] }
    })
    await create(path)
    expect(mocks.invoke).toHaveBeenCalledWith('new_session', expect.objectContaining({
      persona: 'persona', model: path === 'recovery' ? 'changed-model' : 'model',
    }))
    expect(mocks.invoke.mock.calls[0][1]).not.toHaveProperty('mcpServers')
  })

  it.each(['preflight', 'remote'] as const)('%s failure preserves the entry-specific rollback policy', async stage => {
    const error = new Error(`${stage} failed`)
    if (stage === 'preflight') mocks.preflight.mockRejectedValue(error)
    else mocks.invoke.mockRejectedValue(error)
    const pending = create(path)
    if (path === 'recovery') {
      await pending
      expect(mocks.report).toHaveBeenCalledWith('创建会话', error, 'owner', expect.any(Object))
      expect(identity.removeSession).not.toHaveBeenCalled()
    } else {
      await expect(pending).rejects.toBe(error)
      expect(identity.removeSession).toHaveBeenCalledExactlyOnceWith('local-id')
    }
    expect(identity.setSessionPeriId).not.toHaveBeenCalled()
    if (stage === 'preflight') expect(mocks.invoke).not.toHaveBeenCalled()
  })
})

it('workbench preserves explicit model/reasoning/mode and projection-before-binding order', async () => {
  const project = vi.fn()
  await createAgentWorkbenchSession({ model: 'selected', reasoningLevel: 'high', mode: 'plan' }, {
    agentId: 'owner', workspaceMode: 'chat', applySessionResponse: project,
  })
  expect(mocks.invoke).toHaveBeenCalledWith('new_session', expect.objectContaining({ model: 'selected', reasoningLevel: 'high', mode: 'plan' }))
  expect(project).toHaveBeenCalledWith('local-id', expect.objectContaining({ sessionId: 'remote' }))
  expect(project.mock.invocationCallOrder[0]).toBeLessThan(runtime.setBindingGeneration.mock.invocationCallOrder[0])
})

it('CLI cancellation after a remote response rolls back without committing it', async () => {
  const controller = new AbortController()
  const reason = new Error('cancelled')
  mocks.invoke.mockImplementation(async () => { controller.abort(reason); return 'remote-string' })
  await expect(create('cli', controller.signal)).rejects.toBe(reason)
  expect(mocks.preflight).toHaveBeenCalledWith(session, controller.signal)
  expect(identity.removeSession).toHaveBeenCalledWith('local-id')
  expect(identity.setSessionPeriId).not.toHaveBeenCalled()
  expect(mocks.boundary).not.toHaveBeenCalled()
})

it('recovery ignores a late response after the visible session changes', async () => {
  let current = true
  mocks.invoke.mockImplementation(async () => { current = false; return { sessionId: 'late' } })
  await create('recovery', undefined, () => current)
  expect(identity.setSessionPeriId).not.toHaveBeenCalled()
  expect(mocks.apply).not.toHaveBeenCalled()
  expect(runtime.setBindingGeneration).not.toHaveBeenCalled()
})
