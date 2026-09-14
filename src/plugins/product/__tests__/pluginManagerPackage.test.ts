import { describe, expect, it } from 'vitest'
import { loadFirstPartyProductPackages, createBuiltinProductPluginDefinitions } from '../builtinProductPlugins.ts'
import { readPluginContributionFacts } from '../../../plugin-runtime/management/pluginContributionProjection.ts'

describe('sixth first-party package (builtin.pylon-plugin-manager)', () => {
  it('loads seven product packages in dependency order with the gateway last (P77)', () => {
    const packages = loadFirstPartyProductPackages()
    const ids = packages.map(pkg => pkg.manifest.id)
    // 封闭 id 集合由 builtinProductPlugins.test.ts 锁定（= BUILTIN_PYLON_PRODUCT_PLUGIN_IDS），
    // 此处不再重复字面 id 列表；只锁装载序契约：顺序尊重各包 manifest.dependencies（P77），
    // 且 gateway 收尾。
    const position = new Map(ids.map((id, index) => [id, index]))
    for (const pkg of packages) {
      for (const dependency of Object.keys(pkg.manifest.dependencies)) {
        expect(position.get(dependency)!, `${pkg.manifest.id} 必须后于其依赖 ${dependency} 装载`)
          .toBeLessThan(position.get(pkg.manifest.id)!)
      }
    }
    expect(ids.at(-1)).toBe('builtin.pylon-gateway')
  })

  it('declares api 1.2 with the plugin.management capability and full composition fields', () => {
    const manager = loadFirstPartyProductPackages()
      .find(pkg => pkg.manifest.id === 'builtin.pylon-plugin-manager')
    expect(manager).toBeDefined()
    expect(manager!.manifest.api).toBe('1.2')
    expect(manager!.manifest.capabilities).toEqual(['plugin.management'])
    expect(manager!.manifest.kind).toBe('feature')
    expect(manager!.manifest.activation.events).toEqual(['kernel.ready'])
    expect(manager!.manifest.hotSwap.mode).toBe('parallel')
    expect(manager!.manifest.hotSwap.drainTimeoutMs).toBe(5000)
    expect(manager!.manifest.dependencies).toEqual({})
  })

  it('flows capabilities into the runtime definition', () => {
    const definitions = createBuiltinProductPluginDefinitions()
    const manager = definitions.find(definition => definition.id === 'builtin.pylon-plugin-manager')
    expect(manager?.capabilities).toEqual(['plugin.management'])
    expect(manager?.criticality).toBe('product-required')
    expect(manager?.firstParty).toBe(true)
  })
})

describe('contribution projection (contribution overview)', () => {
  const entries = (ownerPluginId: string, ...contributionIds: string[]) => contributionIds.map(contributionId => ({
    contributionId,
    ownerPluginId,
  }))

  it('groups registry entries by owner plugin across surfaces', () => {
    const registries = {
      commandRegistry: { getSnapshot: () => ({ entries: [...entries('plugin.a', 'cmd.x', 'cmd.y'), ...entries('plugin.b', 'cmd.z')] }) },
      rendererRegistry: { getSnapshot: () => ({ entries: entries('plugin.a', 'renderer.r') }) },
    } as never

    const facts = readPluginContributionFacts(registries)

    expect(facts).toEqual([
      {
        pluginId: 'plugin.a',
        contributions: { commands: ['cmd.x', 'cmd.y'], renderers: ['renderer.r'] },
        total: 3,
      },
      { pluginId: 'plugin.b', contributions: { commands: ['cmd.z'] }, total: 1 },
    ])
  })

  it('skips registries without snapshot capability without failing the projection', () => {
    const registries = {
      commandRegistry: { getSnapshot: () => ({ entries: entries('plugin.a', 'cmd.x') }) },
      pluginServiceRegistry: {},
    } as never

    expect(readPluginContributionFacts(registries)).toEqual([
      { pluginId: 'plugin.a', contributions: { commands: ['cmd.x'] }, total: 1 },
    ])
  })
})
