// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { loadFirstPartyProductPackages } from '../builtinProductPlugins.ts'
import { createBuiltinPylonGatewayPlugin } from '../builtinPylonGateway.ts'
import { loadBuiltinPylonGatewayStyles } from '../packages/builtin.pylon-gateway/styleAssets.ts'
import { BUILTIN_PYLON_GATEWAY_ID } from '../productPluginIds.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import type { BuiltinPluginActivationContext } from '../../../plugin-runtime/pluginActivationContext.ts'
import type { PluginScope } from '../../../plugin-runtime/pluginScope.ts'

describe('seventh first-party package (builtin.pylon-gateway, P77)', () => {
  it('loads the gateway package with full composition fields', () => {
    const gateway = loadFirstPartyProductPackages()
      .find(pkg => pkg.manifest.id === BUILTIN_PYLON_GATEWAY_ID)
    expect(gateway).toBeDefined()
    expect(gateway!.manifest.kind).toBe('workspace')
    expect(gateway!.manifest.api).toBe('1.0')
    expect(gateway!.manifest.activation.events).toEqual(['kernel.ready'])
    expect(gateway!.manifest.hotSwap.mode).toBe('parallel')
    expect(gateway!.manifest.hotSwap.drainTimeoutMs).toBe(10000)
    expect(gateway!.manifest.dependencies).toEqual({})
    expect(gateway!.manifest.capabilities).toBeUndefined()
  })

  it('activate registers the gateway workspace type with launch metadata intact', () => {
    const registerType = vi.fn()
    const scope = { add: vi.fn() } as unknown as PluginScope
    const context = {
      identity: createPluginIdentity(BUILTIN_PYLON_GATEWAY_ID, 'test-instance'),
      scope,
      workspace: { registerType },
    } as unknown as BuiltinPluginActivationContext

    createBuiltinPylonGatewayPlugin().activate(context)

    expect(registerType).toHaveBeenCalledTimes(1)
    const definition = registerType.mock.calls[0]![0] as { kind: string; launch?: { kind?: string } }
    expect(definition.kind).toBe('gateway')
    expect(definition.launch).toMatchObject({ kind: 'gateway', launchable: true, icon: 'waypoints' })
  })

  it('activate mounts package styles under the plugin scope', () => {
    // jsdom document 在同文件用例间共享——先清掉历史挂载，只断言本次 activate 的增量。
    document.querySelectorAll('style[data-pylon-plugin-style="builtin.pylon-gateway"]').forEach(node => node.remove())
    const scopeAdds: Array<() => void> = []
    const scope = { add: (cleanup: () => void) => scopeAdds.push(cleanup) } as unknown as PluginScope
    const context = {
      identity: createPluginIdentity(BUILTIN_PYLON_GATEWAY_ID, 'test-instance'),
      scope,
      workspace: { registerType: vi.fn() },
    } as unknown as BuiltinPluginActivationContext

    createBuiltinPylonGatewayPlugin().activate(context)

    const mounted = document.querySelectorAll<HTMLElement>('style[data-pylon-plugin-style="builtin.pylon-gateway"]')
    expect(mounted.length).toBe(1)
    expect(mounted[0]!.dataset.pylonPluginStylePath).toContain('GatewaySheet.css')
    expect(scopeAdds.length).toBe(1)
  })

  it('style loader yields exactly the gateway sheet asset', () => {
    const assets = loadBuiltinPylonGatewayStyles()
    expect(assets).toHaveLength(1)
    expect(assets[0]!.path).toContain('GatewaySheet.css')
    // vitest 默认 css:false 时 `?inline` 内容为空串——内容注入属构建管线，不在此断言。
    expect(typeof assets[0]!.css).toBe('string')
  })
})
