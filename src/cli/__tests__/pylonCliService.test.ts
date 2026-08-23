import { describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity.ts'
import { PylonCliService, createPylonCliTool, type InteractionItem, type PylonCliServicePorts } from '../pylonCliService.ts'

function harness(overrides: Partial<PylonCliServicePorts> = {}) {
  const identity = createPluginIdentity('demo.plugin', 'run-1')
  const plugins = {
    snapshot: vi.fn(() => ({
      revision: 7,
      active: [identity],
      switches: [{ pluginId: 'demo.plugin', adoptedMode: 'parallel' }],
    })),
    enable: vi.fn(async (pluginId: string) => ({ pluginId, enabled: true })),
    disable: vi.fn(async (pluginId: string) => ({ pluginId, disabled: true })),
    reload: vi.fn(async (pluginId: string, mode?: 'parallel' | 'exclusive' | 'soft-remount' | 'restart-required') => ({
      pluginId,
      previousRuntimeInstanceId: identity.key,
      runtimeInstanceId: `${identity.key}-next`,
      declaredMode: mode ?? 'parallel',
      adoptedMode: mode ?? 'parallel',
    })),
  }
  const hooks = {
    list: vi.fn(() => [{
      hookName: 'turn.started', handlerId: 'observe', pluginId: 'demo.plugin',
      runtimeInstanceId: identity.key, priority: 100, execution: 'blocking', failurePolicy: 'continue',
    }]),
    trace: vi.fn(() => [{
      invocationId: 'turn.started#1', hookName: 'turn.started' as const, pluginId: 'demo.plugin',
      runtimeInstanceId: identity.key, handlerId: 'observe', startedAt: 1, durationMs: 2, outcome: 'continued' as const,
    }]),
  }
  const commands = {
    execute: vi.fn(async (commandId: string, args: unknown) => commandId === 'skin.capture'
      ? { commandId, args, supported: true, status: 'captured', artifactRef: 'preview.png' }
      : { commandId, args }),
    list: vi.fn(() => [{ id: 'demo.command', ownerPluginId: 'demo.plugin', executable: true }]),
    describe: vi.fn((commandId: string) => commandId === 'demo.command' ? { id: commandId, executable: true } : null),
  }
  const processes = {
    list: vi.fn(async () => [{
      processId: 'proc-1', pluginId: 'demo.plugin', runtimeInstanceId: identity.key,
      executableId: 'service', status: 'running' as const, restartAttempts: 0,
    }]),
    logs: vi.fn(async () => [{
      processId: 'proc-1', pluginId: 'demo.plugin', runtimeInstanceId: identity.key,
      sequence: 1, kind: 'stdout' as const, dataBase64: 'b2s=',
    }]),
    terminate: vi.fn(async () => undefined),
  }
  const workspaces = {
    list: vi.fn(() => [{ id: 'sheet-1', kind: 'overview', title: 'Overview', createdAt: 1, lastFocusedAt: 1 }]),
    open: vi.fn(() => 'sheet-2'),
    close: vi.fn(async () => true),
  }
  const agents = {
    list: vi.fn(async () => ({ agents: [{ id: 'peri', name: 'Peri' }], candidates: [], catalog: [] })),
    import: vi.fn(async (input: { candidateId: string, agentId?: string }) => ({ ...input, imported: true })),
    setDefault: vi.fn(async (agentId: string) => ({ agentId, default: true })),
  }
  const sessions = {
    list: vi.fn(() => [{
      id: 's-1', agentId: 'peri', name: 'CLI session', source: 'local:s-1', profileId: 'p',
      createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '',
    }]),
    inspect: vi.fn(async (sessionId: string) => ({ sessionId, generating: false })),
    create: vi.fn(async (input: { agentId?: string, cwd?: string, workspaceId?: string, title?: string }) => ({ sessionId: 's-2', ...input })),
    send: vi.fn(async (sessionId: string, content: string, _options: { signal: AbortSignal }) => ({ sessionId, content, accepted: true })),
    close: vi.fn(async () => true),
    cancel: vi.fn(async () => true),
    messages: vi.fn(async (sessionId: string) => ({ sessionId, events: [], lastSequence: 0 })),
  }
  const approval = { get: vi.fn(async () => 'default'), set: vi.fn(async () => {}) }
  const interactions = {
    list: vi.fn(async () => ({ items: [] as InteractionItem[] })),
    respond: vi.fn(async (_identity: unknown, _kind: string, _answer: unknown) => {}),
  }
  const workspaceRegistry = {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({})),
    search: vi.fn(async () => []),
  }
  const sessionConfig = {
    setOption: vi.fn(async () => ({})),
    exportSession: vi.fn(async () => {}),
  }
  const registries = { snapshot: vi.fn(() => ({ commands: [{ id: 'demo.command' }], workspaces: [] })) }
  const packages = {
    list: vi.fn(async () => [{ package: { pluginId: 'demo.package' }, enabled: true }]),
    inspect: vi.fn(async (sourcePath: string) => ({ pluginId: 'demo.package', sourcePath })),
    installOrUpdate: vi.fn(async () => ({ ok: true as const })),
    setEnabled: vi.fn(async () => ({ ok: true as const })),
    reload: vi.fn(async () => ({ ok: true as const })),
    versions: vi.fn(async () => [{ pluginId: 'demo.package', version: '1.0.0' }]),
    rollback: vi.fn(async (pluginId: string, packageInstanceId?: string) => ({ pluginId, packageInstanceId })),
    uninstall: vi.fn(async () => ({ ok: true as const })),
  }
  let operation = 0
  const ports: PylonCliServicePorts = {
    plugins,
    hooks,
    commands,
    processes,
    workspaces,
    agents,
    sessions,
    approval,
    interactions,
    workspaceRegistry,
    sessionConfig,
    registries,
    packages,
    now: () => 100 + operation,
    createOperationId: () => `op-${++operation}`,
    ...overrides,
  }
  return { service: new PylonCliService(ports), plugins, hooks, commands, processes, workspaces, agents, sessions, approval, interactions, workspaceRegistry, sessionConfig, registries, packages }
}

describe('PylonCliService typed command surface', () => {
  it('covers plugin list/inspect/enable/disable/reload', async () => {
    const { service, plugins } = harness()
    await expect(service.execute({ command: 'plugin list' })).resolves.toMatchObject({ revision: 7 })
    await expect(service.execute({ command: 'plugin inspect', args: { positionals: ['demo.plugin'] } }))
      .resolves.toMatchObject({ pluginId: 'demo.plugin', instances: [{ pluginId: 'demo.plugin' }] })
    await expect(service.execute({ command: 'plugin enable', args: { pluginId: 'demo.plugin' } }))
      .resolves.toMatchObject({ operationId: 'op-1' })
    await expect(service.execute({ command: 'plugin disable', args: { positionals: ['demo.plugin'] } }))
      .resolves.toMatchObject({ operationId: 'op-2' })
    await expect(service.execute({ command: 'plugin reload', args: { pluginId: 'demo.plugin', mode: 'exclusive' } }))
      .resolves.toMatchObject({ operationId: 'op-3', result: { adoptedMode: 'exclusive' } })
    expect(plugins.enable).toHaveBeenCalledWith('demo.plugin')
    expect(plugins.disable).toHaveBeenCalledWith('demo.plugin')
    expect(plugins.reload).toHaveBeenCalledWith('demo.plugin', 'exclusive')
  })

  it('covers package inspection, persistent lifecycle, versions, rollback and uninstall', async () => {
    const { service, packages } = harness()
    await expect(service.execute({ command: 'package list' })).resolves.toHaveLength(1)
    await expect(service.execute({ command: 'package inspect', args: { positionals: ['G:/plugin'] } })).resolves.toMatchObject({ pluginId: 'demo.package' })
    await expect(service.execute({ command: 'package install', args: { sourcePath: 'G:/plugin' } })).resolves.toMatchObject({ operationId: 'op-1' })
    await expect(service.execute({ command: 'package enable', args: { pluginId: 'demo.package' } })).resolves.toMatchObject({ operationId: 'op-2' })
    await expect(service.execute({ command: 'package disable', args: { positionals: ['demo.package'] } })).resolves.toMatchObject({ operationId: 'op-3' })
    await expect(service.execute({ command: 'package reload', args: { pluginId: 'demo.package' } })).resolves.toMatchObject({ operationId: 'op-4' })
    await expect(service.execute({ command: 'package versions', args: { pluginId: 'demo.package' } })).resolves.toHaveLength(1)
    await expect(service.execute({ command: 'package rollback', args: { positionals: ['demo.package'], packageInstanceId: 'pkg-1' } })).resolves.toMatchObject({ operationId: 'op-5' })
    await expect(service.execute({ command: 'package uninstall', args: { pluginId: 'demo.package', purgeData: true } })).resolves.toMatchObject({ operationId: 'op-6' })
    expect(packages.setEnabled).toHaveBeenNthCalledWith(1, 'demo.package', true)
    expect(packages.setEnabled).toHaveBeenNthCalledWith(2, 'demo.package', false)
    expect(packages.reload).toHaveBeenCalledWith('demo.package')
    expect(packages.uninstall).toHaveBeenCalledWith('demo.package', true)
  })

  it('covers hook list/trace filters', async () => {
    const { service } = harness()
    await expect(service.execute({ command: 'hook list', args: { name: 'turn.started', plugin: 'demo.plugin' } }))
      .resolves.toHaveLength(1)
    await expect(service.execute({ command: 'hook trace', args: { hook: 'turn.started', limit: 10 } }))
      .resolves.toMatchObject([{ invocationId: 'turn.started#1' }])
  })

  it('routes every initial skin command through the shared Command Registry port', async () => {
    const { service, commands } = harness()
    await service.execute({ command: 'skin schema' })
    await service.execute({ command: 'skin draft create', args: { name: 'Deep Sea' } })
    await service.execute({ command: 'skin draft patch', args: { draftId: 'draft-1', patch: { tokens: { accent: '#fff' } } } })
    await service.execute({ command: 'skin preview', args: { draftId: 'draft-1', target: { scope: 'global' } } })
    await service.execute({ command: 'skin capture', args: { previewId: 'preview-1', out: 'preview.png' } })
    await service.execute({ command: 'skin commit', args: { previewId: 'preview-1' } })
    await service.execute({ command: 'skin rollback', args: { previewId: 'preview-2' } })
    expect(commands.execute.mock.calls.map(call => call[0])).toEqual([
      'skin.schema', 'skin.draft.create', 'skin.draft.patch', 'skin.preview',
      'skin.capture', 'skin.commit', 'skin.rollback',
    ])
    expect(commands.execute).toHaveBeenCalledWith('skin.capture', {
      previewId: 'preview-1', options: { format: undefined, artifactPath: 'preview.png' },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('covers process list/logs/terminate', async () => {
    const { service, processes } = harness()
    await expect(service.execute({ command: 'process list', args: { plugin: 'demo.plugin' } })).resolves.toHaveLength(1)
    await expect(service.execute({ command: 'process logs', args: { processId: 'proc-1', stream: 'stdout', limit: 12 } }))
      .resolves.toMatchObject([{ kind: 'stdout' }])
    await expect(service.execute({ command: 'process terminate', args: { positionals: ['proc-1'] } }))
      .resolves.toMatchObject({ operationId: 'op-1', result: { terminated: true } })
    expect(processes.logs).toHaveBeenCalledWith('proc-1', 'stdout', 12)
    expect(processes.terminate).toHaveBeenCalledWith('proc-1')
  })

  it('covers workspace list/open/close', async () => {
    const { service, workspaces } = harness()
    await expect(service.execute({ command: 'workspace list' })).resolves.toMatchObject([{ id: 'sheet-1' }])
    await expect(service.execute({ command: 'workspace open', args: { type: 'overview', title: 'CLI' } }))
      .resolves.toMatchObject({ operationId: 'op-1', result: { workspaceId: 'sheet-2' } })
    await expect(service.execute({ command: 'workspace close', args: { workspaceId: 'sheet-2' } }))
      .resolves.toMatchObject({ operationId: 'op-2', result: { closed: true } })
    expect(workspaces.open).toHaveBeenCalledWith(expect.objectContaining({ type: 'overview', title: 'CLI' }))
    expect(workspaces.close).toHaveBeenCalledWith('sheet-2')
  })

  it('executes arbitrary registered commands with forwarded args and operation wrapping', async () => {
    const { service, commands } = harness()
    await expect(service.execute({
      command: 'command exec',
      args: { positionals: ['builtin.file.search'], query: 'TODO', limit: 12 },
    })).resolves.toMatchObject({ operationId: 'op-1', result: { commandId: 'builtin.file.search' } })
    expect(commands.execute).toHaveBeenCalledWith(
      'builtin.file.search', { query: 'TODO', limit: 12 }, expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    await service.execute({ command: 'command exec', args: { positionals: ['model', 'deepseek-v4'] } })
    expect(commands.execute).toHaveBeenLastCalledWith(
      'model', { positionals: ['deepseek-v4'] }, expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('discovers commands and all plugin contribution registries', async () => {
    const { service, commands, registries } = harness()
    await expect(service.execute({ command: 'command list', args: { plugin: 'demo.plugin', executable: true } }))
      .resolves.toMatchObject([{ id: 'demo.command' }])
    expect(commands.list).toHaveBeenCalledWith({ ownerPluginIds: ['demo.plugin'], executable: true })
    await expect(service.execute({ command: 'command inspect', args: { positionals: ['demo.command'] } }))
      .resolves.toMatchObject({ id: 'demo.command', executable: true })
    await expect(service.execute({ command: 'registry list' })).resolves.toMatchObject({ commands: [{ id: 'demo.command' }] })
    expect(registries.snapshot).toHaveBeenCalledOnce()
  })

  it('covers agent list/import/set-default through the agent control port', async () => {
    const { service, agents } = harness()
    await expect(service.execute({ command: 'agent list' })).resolves.toMatchObject({ agents: [{ id: 'peri' }] })
    await expect(service.execute({ command: 'agent import', args: { positionals: ['peri:path'], agentId: 'peri-local' } }))
      .resolves.toMatchObject({ operationId: 'op-1', result: { candidateId: 'peri:path', agentId: 'peri-local' } })
    await expect(service.execute({ command: 'agent set-default', args: { positionals: ['peri-local'] } }))
      .resolves.toMatchObject({ operationId: 'op-2', result: { default: true } })
    expect(agents.import).toHaveBeenCalledWith(
      { candidateId: 'peri:path', agentId: 'peri-local' }, expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('covers session list/create/send/close/cancel and aggregated event log', async () => {
    const { service, sessions } = harness()
    await expect(service.execute({ command: 'session list' })).resolves.toMatchObject([{ id: 's-1' }])
    await expect(service.execute({ command: 'session create', args: { agentId: 'peri', cwd: 'G:/repo', title: 'Work' } }))
      .resolves.toMatchObject({ operationId: 'op-1', result: { sessionId: 's-2' } })
    await expect(service.execute({ command: 'session send', args: { positionals: ['s-1', 'hello'] } }))
      .resolves.toMatchObject({ operationId: 'op-2', result: { accepted: true } })
    await expect(service.execute({ command: 'session close', args: { sessionId: 's-1' } }))
      .resolves.toMatchObject({ operationId: 'op-3', result: { closed: true } })
    await expect(service.execute({ command: 'session cancel', args: { positionals: ['s-1'] } }))
      .resolves.toMatchObject({ operationId: 'op-4', result: { cancelled: true } })
    await expect(service.execute({ command: 'event log', args: { limit: 2 } }))
      .resolves.toMatchObject({ operations: [{ operationId: 'op-3' }, { operationId: 'op-4' }], hooks: expect.any(Array) })
    expect(sessions.send).toHaveBeenCalledWith('s-1', 'hello', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('covers CLI enhancements: session inspect/messages, approval mode, interaction list/respond', async () => {
    const { service, approval, interactions } = harness()
    // session inspect：实时观测维度
    await expect(service.execute({ command: 'session inspect', args: { sessionId: 's-1' } }))
      .resolves.toMatchObject({ sessionId: 's-1' })
    await expect(service.execute({ command: 'session messages', args: { sessionId: 's-1', afterSeq: 3 } }))
      .resolves.toMatchObject({ operationId: 'op-1', result: { sessionId: 's-1', lastSequence: 0 } })
    // approval get/set
    await expect(service.execute({ command: 'approval get' })).resolves.toEqual({ mode: 'default' })
    await expect(service.execute({ command: 'approval set', args: { mode: 'auto' } })).resolves.toEqual({ mode: 'auto' })
    expect(approval.set).toHaveBeenCalledWith('auto')
    // interaction respond：requestId 解析 + optionId 校验 + identity 透传
    interactions.list.mockResolvedValueOnce({
      items: [{
        provider: 'peri', agentId: 'a1', requestId: 'req-9', sessionId: 's-1',
        toolCallId: 'tc-1', clientGeneration: 2, title: '写文件', prompt: 'path=x',
        options: [{ optionId: 'allow_once' }, { optionId: 'reject_once' }],
        requestedAt: '2026-08-23T00:00:00Z', deadlineMs: 300000,
      }],
    })
    await expect(service.execute({ command: 'interaction respond', args: { positionals: ['req-9', 'allow_once'] } }))
      .resolves.toMatchObject({ operationId: 'op-2', result: { requestId: 'req-9', responded: true } })
    expect(interactions.respond).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'peri', requestId: 'req-9', clientGeneration: 2 }),
      'permission',
      { optionId: 'allow_once' },
    )
    // 非法 optionId 拒绝
    interactions.list.mockResolvedValueOnce({
      items: [{
        provider: 'peri', agentId: 'a1', requestId: 'req-9', sessionId: 's-1',
        toolCallId: 'tc-1', clientGeneration: 2, title: '', prompt: '',
        options: [{ optionId: 'allow_once' }], requestedAt: '', deadlineMs: 0,
      }],
    })
    await expect(service.execute({ command: 'interaction respond', args: { positionals: ['req-9', 'bogus'] } }))
      .rejects.toThrow(/非法 optionId/)
  })

  it('aborts an in-flight session send through operation cancel', async () => {
    let observedSignal: AbortSignal | undefined
    let release: (() => void) | undefined
    const blocked = new Promise<void>(resolve => { release = resolve })
    const base = harness()
    base.sessions.send.mockImplementation(async (sessionId, content, options) => {
      observedSignal = options.signal
      await blocked
      return { sessionId, content, accepted: true }
    })
    const pending = base.service.execute({ command: 'session send', args: { positionals: ['s-1', 'hello'] } })
    await Promise.resolve()
    await base.service.execute({ command: 'operation cancel', args: { operationId: 'op-1' } })
    expect(observedSignal?.aborted).toBe(true)
    release?.()
    await expect(pending).rejects.toThrow()
    await expect(base.service.execute({ command: 'operation inspect', args: { operationId: 'op-1' } }))
      .resolves.toMatchObject({ status: 'cancelled' })
  })

  it('records mutation logs and supports inspect/log/cancel', async () => {
    let resolveEnable: ((value: unknown) => void) | undefined
    const deferred = new Promise<{ pluginId: string, enabled: boolean }>(resolve => {
      resolveEnable = resolve as (value: unknown) => void
    })
    const base = harness()
    base.plugins.enable.mockImplementation(async () => deferred)
    const pending = base.service.execute({ command: 'plugin enable', args: { pluginId: 'demo.plugin' } })
    await Promise.resolve()
    await expect(base.service.execute({ command: 'operation inspect', args: { operationId: 'op-1' } }))
      .resolves.toMatchObject({ status: 'running' })
    await expect(base.service.execute({ command: 'operation logs', args: { operationId: 'op-1' } }))
      .resolves.toEqual(['started plugin enable'])
    await base.service.execute({ command: 'operation cancel', args: { operationId: 'op-1' } })
    resolveEnable?.({ pluginId: 'demo.plugin', enabled: true })
    await expect(pending).rejects.toThrow()
    await expect(base.service.execute({ command: 'operation inspect', args: { operationId: 'op-1' } }))
      .resolves.toMatchObject({ status: 'cancelled' })
  })

  it('exposes one structured pylon_cli Agent Tool and structured errors', async () => {
    const { service } = harness()
    const tool = createPylonCliTool(service)
    expect(tool.name).toBe('pylon_cli')
    await expect(tool.execute({ command: 'skin schema' })).resolves.toMatchObject({ ok: true })
    await expect(tool.execute({ command: 'not real' })).resolves.toEqual({
      ok: false,
      error: { code: 'pylon_cli_error', message: '未知 Pylon CLI 命令：not real' },
    })
  })
})
