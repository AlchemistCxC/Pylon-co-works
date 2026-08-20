import { describe, expect, it, vi } from 'vitest'
import {
  createPluginProcessClient,
  type PluginProcessEvent,
} from './pluginProcessClient.ts'

function harness() {
  let eventListener: ((event: { payload: PluginProcessEvent }) => void) | undefined
  const invoke = vi.fn<(command: string, args?: unknown) => Promise<unknown>>(async (command: string) => {
    if (command === 'plugin_process_spawn') {
      return {
        processId: 'proc-1',
        pluginId: 'p.demo',
        runtimeInstanceId: 'p.demo@run-1',
        executableId: 'service',
        status: 'running',
        pid: 42,
        restartAttempts: 0,
      }
    }
    if (command === 'plugin_process_request') return { answer: 42 }
    return undefined
  })
  const listen = vi.fn(async (_event: string, listener: (event: { payload: PluginProcessEvent }) => void) => {
    eventListener = listener
    return () => undefined
  })
  const client = createPluginProcessClient({ transport: { invoke }, events: { listen } })
  return {
    client,
    invoke,
    listen,
    emit: (event: Partial<PluginProcessEvent>) => eventListener?.({
      payload: {
        processId: 'proc-1',
        pluginId: 'p.demo',
        runtimeInstanceId: 'p.demo@run-1',
        sequence: 1,
        kind: 'status',
        ...event,
      },
    }),
  }
}

describe('pluginProcessClient', () => {
  it('subscribes before spawn and routes binary stream/exit events', async () => {
    const { client, invoke, listen, emit } = harness()
    const handle = await client.spawn('p.demo', 'p.demo@run-1', 'service', { protocol: 'json-rpc' })
    expect(listen).toHaveBeenCalledWith('pylon:plugin-process', expect.any(Function))
    expect(invoke).toHaveBeenCalledWith('plugin_process_spawn', {
      pluginId: 'p.demo',
      runtimeInstanceId: 'p.demo@run-1',
      executableId: 'service',
      options: { protocol: 'json-rpc' },
    })

    const stdout = vi.fn()
    const exited = vi.fn()
    handle.onStdout(stdout)
    handle.onExit(exited)
    emit({ kind: 'stdout', dataBase64: btoa('hello') })
    emit({ kind: 'exit', value: { exitCode: 0, reason: 'exited' } })
    expect(new TextDecoder().decode(stdout.mock.calls[0][0] as Uint8Array)).toBe('hello')
    expect(exited).toHaveBeenCalledWith({ exitCode: 0, reason: 'exited' })
    expect(handle.status).toBe('exited')
  })

  it('writes UTF-8/base64 and correlates typed requests', async () => {
    const { client, invoke } = harness()
    const handle = await client.spawn('p.demo', 'p.demo@run-1', 'service')
    await handle.write('你好')
    expect(invoke).toHaveBeenCalledWith('plugin_process_write', {
      processId: 'proc-1',
      dataBase64: '5L2g5aW9',
    })
    await expect(handle.request<{ answer: number }>('echo', { value: 1 })).resolves.toEqual({ answer: 42 })
    expect(invoke).toHaveBeenCalledWith('plugin_process_request', expect.objectContaining({
      processId: 'proc-1', method: 'echo', params: { value: 1 }, timeoutMs: 30_000,
    }))
  })

  it('AbortSignal sends native JSON-RPC cancellation', async () => {
    const { client, invoke } = harness()
    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin_process_spawn') {
        return {
          processId: 'proc-1', pluginId: 'p.demo', runtimeInstanceId: 'p.demo@run-1',
          executableId: 'service', status: 'running', restartAttempts: 0,
        }
      }
      if (command === 'plugin_process_request') return new Promise(() => undefined)
      return undefined
    })
    const handle = await client.spawn('p.demo', 'p.demo@run-1', 'service')
    const controller = new AbortController()
    const request = handle.request('slow', undefined, { signal: controller.signal })
    controller.abort(new Error('stop'))
    await expect(request).rejects.toThrow('stop')
    expect(invoke).toHaveBeenCalledWith('plugin_process_cancel', expect.objectContaining({
      processId: 'proc-1',
      requestId: expect.stringContaining(':web:'),
    }))
  })

  it('exposes retained logs and terminate by process id for the CLI service', async () => {
    const { client, invoke } = harness()
    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin_process_logs') return [{
        processId: 'proc-1', pluginId: 'p.demo', runtimeInstanceId: 'p.demo@run-1',
        sequence: 2, kind: 'stderr', dataBase64: 'ZXJy',
      }]
      return undefined
    })
    await expect(client.logs('proc-1', 'stderr', 12)).resolves.toMatchObject([{ kind: 'stderr' }])
    await client.terminate('proc-1')
    expect(invoke).toHaveBeenCalledWith('plugin_process_logs', { processId: 'proc-1', stream: 'stderr', limit: 12 })
    expect(invoke).toHaveBeenCalledWith('plugin_process_terminate', { processId: 'proc-1' })
  })
})
