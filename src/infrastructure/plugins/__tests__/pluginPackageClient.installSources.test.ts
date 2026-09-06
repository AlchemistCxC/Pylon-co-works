import { describe, expect, it } from 'vitest'
import { createPluginPackageClient } from '../pluginPackageClient.ts'
import type { ClientTransport } from '../pluginClientTransport.ts'

/**
 * P53 D6：zip/URL 安装源的前端 client 契约——命令名与参数映射锁定。
 */
describe('plugin package client zip/url install sources', () => {
  function transportRecording() {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
    const transport: ClientTransport = {
      invoke: (cmd, args) => {
        calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> })
        return Promise.resolve({})
      },
    }
    return { calls, transport }
  }

  it('inspectZip maps to plugin_package_inspect_zip with zipPath', async () => {
    const { calls, transport } = transportRecording()
    const client = createPluginPackageClient({ transport, convertResourceUrl: url => url })
    await client.inspectZip('C:/packages/demo.zip')
    expect(calls[0]).toEqual({ cmd: 'plugin_package_inspect_zip', args: { zipPath: 'C:/packages/demo.zip' } })
  })

  it('inspectUrl maps to plugin_package_inspect_url with url', async () => {
    const { calls, transport } = transportRecording()
    const client = createPluginPackageClient({ transport, convertResourceUrl: url => url })
    await client.inspectUrl('https://example.com/demo.zip')
    expect(calls[0]).toEqual({ cmd: 'plugin_package_inspect_url', args: { url: 'https://example.com/demo.zip' } })
  })

  it('installFromZip maps to plugin_install_from_zip with zipPath and expectedId', async () => {
    const { calls, transport } = transportRecording()
    const client = createPluginPackageClient({ transport, convertResourceUrl: url => url })
    await client.installFromZip('C:/packages/demo.zip', 'demo.plugin')
    expect(calls[0]).toEqual({
      cmd: 'plugin_install_from_zip',
      args: { zipPath: 'C:/packages/demo.zip', expectedId: 'demo.plugin' },
    })
  })

  it('installFromUrl maps to plugin_install_from_url with url and expectedId', async () => {
    const { calls, transport } = transportRecording()
    const client = createPluginPackageClient({ transport, convertResourceUrl: url => url })
    await client.installFromUrl('https://example.com/demo.zip', 'demo.plugin')
    expect(calls[0]).toEqual({
      cmd: 'plugin_install_from_url',
      args: { url: 'https://example.com/demo.zip', expectedId: 'demo.plugin' },
    })
  })
})
