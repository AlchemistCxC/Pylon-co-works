import { describe, expect, it, vi } from 'vitest'
import type {
  NativePluginProcessHandle,
  PluginProcessClient,
} from '../../infrastructure/plugins/pluginProcessClient.ts'
import { createPackagePluginIdentity, createPluginIdentity } from '../pluginIdentity.ts'
import { PluginRuntime } from '../pluginRuntime.ts'
import { PluginScope } from '../pluginScope.ts'
import { createPluginProcessApi } from './pluginProcessApi.ts'
import { setPluginProcessClientForTests } from './processRuntimeServices.ts'

function fakeHandle(): NativePluginProcessHandle {
  return {
    processId: 'proc-test',
    status: 'running',
    write: vi.fn(async () => undefined),
    request: vi.fn(async () => undefined) as unknown as NativePluginProcessHandle['request'],
    terminate: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
    onStdout: vi.fn(() => ({ dispose: vi.fn() })),
    onStderr: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(async () => undefined),
  }
}

function fakeClient(handle: NativePluginProcessHandle): PluginProcessClient {
  return {
    spawn: vi.fn(async () => handle),
    list: vi.fn(async () => []),
    logs: vi.fn(async () => []),
    terminate: vi.fn(async () => undefined),
  }
}

describe('PluginProcessApi lifecycle', () => {
  it('binds spawned handles to owner identity and Scope disposal', async () => {
    const identity = createPluginIdentity('p.demo', 'run-1')
    const scope = new PluginScope(identity.key)
    const handle = fakeHandle()
    const client = fakeClient(handle)
    const api = createPluginProcessApi(identity, scope, client)
    expect(await api.spawn('service')).toBe(handle)
    expect(client.spawn).toHaveBeenCalledWith('p.demo', 'p.demo@run-1', 'service', undefined, undefined)
    await scope.dispose()
    expect(handle.dispose).toHaveBeenCalledOnce()
  })

  it('activation rollback and normal deactivation both terminate owned processes', async () => {
    const rollbackHandle = fakeHandle()
    const rollbackClient = fakeClient(rollbackHandle)
    let restore = setPluginProcessClientForTests(rollbackClient)
    const rollbackRuntime = new PluginRuntime()
    await expect(rollbackRuntime.activateBuiltin({
      id: 'p.rollback',
      activate: async ({ process }) => {
        await process.spawn('service')
        throw new Error('activation failed')
      },
    })).rejects.toMatchObject({ rollback: { disposed: 1 } })
    expect(rollbackHandle.dispose).toHaveBeenCalledOnce()
    restore()

    const activeHandle = fakeHandle()
    restore = setPluginProcessClientForTests(fakeClient(activeHandle))
    const runtime = new PluginRuntime()
    const instance = await runtime.activateBuiltin({
      id: 'p.active',
      activate: async ({ process }) => {
        await process.spawn('service')
      },
    })
    await runtime.deactivate(instance.identity.key)
    expect(activeHandle.dispose).toHaveBeenCalledOnce()
    restore()
  })

  it('candidate process resolves executable from its staged package, not the active pointer', async () => {
    const identity = createPackagePluginIdentity({
      pluginId: 'p.candidate', version: '2.0.0',
      packageInstanceId: 'p.candidate@2.0.0-hash',
      runtimeInstanceId: 'p.candidate@2.0.0-hash#run-2',
    })
    const handle = fakeHandle()
    const client = fakeClient(handle)
    await createPluginProcessApi(identity, new PluginScope(identity.key), client).spawn('service')
    expect(client.spawn).toHaveBeenCalledWith(
      'p.candidate', identity.key, 'service', undefined, identity.packageInstanceId,
    )
  })
})
