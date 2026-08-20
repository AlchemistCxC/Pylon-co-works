import { describe, expect, it, vi } from 'vitest'
import { createPluginPackageClient } from './pluginPackageClient.ts'

describe('pluginPackageClient v2', () => {
  it('uses typed package commands without a Record<string,string> payload', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'plugin_package_inspect') {
        return {
          pluginId: 'p.demo', version: '1.0.0', packageInstanceId: 'p.demo@1.0.0-abcd',
          manifest: { id: 'p.demo' }, files: [{ path: 'assets/a.bin', size: 4, mime: 'application/octet-stream' }],
          totalBytes: 4, active: false,
        }
      }
      return undefined
    })
    const client = createPluginPackageClient({ transport: { invoke } })
    const result = await client.inspect('C:/plugin')
    expect(result.files).toEqual([{ path: 'assets/a.bin', size: 4, mime: 'application/octet-stream' }])
    expect(invoke).toHaveBeenCalledWith('plugin_package_inspect', { sourcePath: 'C:/plugin' })
  })

  it('streams and range-reads through the resource protocol', async () => {
    const invoke = vi.fn(async () => 'pylon-plugin://p.demo@1.0.0-abcd/assets/a.bin')
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(new Uint8Array([2, 3, 4]), { status: init?.headers ? 206 : 200 }))
    const client = createPluginPackageClient({
      transport: { invoke },
      fetch: fetchMock as typeof fetch,
      convertResourceUrl: value => value.replace('pylon-plugin://', 'http://pylon-plugin.localhost/'),
    })
    expect([...await client.readRange('p.demo@1.0.0-abcd', 'assets/a.bin', 2, 4)]).toEqual([2, 3, 4])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://pylon-plugin.localhost/p.demo@1.0.0-abcd/assets/a.bin',
      expect.objectContaining({ headers: { Range: 'bytes=2-4' } }),
    )
    expect(await client.openStream('p.demo@1.0.0-abcd', 'assets/a.bin')).toBeInstanceOf(ReadableStream)
  })

  it('rejects invalid ranges before network access', async () => {
    const fetchMock = vi.fn()
    const client = createPluginPackageClient({ transport: { invoke: vi.fn() }, fetch: fetchMock })
    await expect(client.readRange('p', 'a', 8, 2)).rejects.toBeInstanceOf(RangeError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exposes staged package commit/abort as typed pointer transaction commands', async () => {
    const invoke = vi.fn(async () => ({ operationId: 'stage-1', package: {} }))
    const client = createPluginPackageClient({ transport: { invoke } })
    await client.stage('C:/candidate', 'p.demo')
    await client.commitStage('stage-1')
    await client.abortStage('stage-2')
    expect(invoke).toHaveBeenNthCalledWith(1, 'plugin_package_stage', {
      sourcePath: 'C:/candidate', expectedId: 'p.demo',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'plugin_package_stage_commit', { operationId: 'stage-1' })
    expect(invoke).toHaveBeenNthCalledWith(3, 'plugin_package_stage_abort', { operationId: 'stage-2' })
  })

  it('lists installed API 1.0 packages and persists enablement through v2 commands', async () => {
    const invoke = vi.fn(async () => [])
    const client = createPluginPackageClient({ transport: { invoke } })
    await expect(client.list()).resolves.toEqual([])
    await client.setEnabled('feature.demo', false)
    expect(invoke).toHaveBeenNthCalledWith(1, 'plugin_package_list')
    expect(invoke).toHaveBeenNthCalledWith(2, 'plugin_package_set_enabled', {
      pluginId: 'feature.demo', enabled: false,
    })
  })
})
