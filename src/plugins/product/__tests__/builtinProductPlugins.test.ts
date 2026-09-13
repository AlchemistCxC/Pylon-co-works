import { describe, expect, it } from 'vitest'
import { createBuiltinProductPluginDefinitions, loadFirstPartyProductPackages } from '../builtinProductPlugins.ts'
import { BUILTIN_PYLON_PRODUCT_PLUGIN_IDS } from '../productPluginIds.ts'

describe('first-party product plugin contracts', () => {
  it('preserves manifest dependency ranges, conflicts and activation events in runtime definitions', () => {
    const shell = createBuiltinProductPluginDefinitions()
      .find(definition => definition.id === 'builtin.pylon-shell')

    expect(shell).toMatchObject({
      dependencies: {
        'builtin.pylon-workspace': '^1.0.0',
        'builtin.pylon-renderers': '^1.0.0',
        'builtin.pylon-agent-adapters': '^1.0.0',
        'builtin.pylon-tools': '^1.0.0',
      },
      optionalDependencies: {},
      conflicts: [],
      activationEvents: ['kernel.ready'],
    })
  })

  it('keeps the loaded package id set equal to the closed product plugin id list', () => {
    expect(loadFirstPartyProductPackages().map(pkg => pkg.manifest.id).sort())
      .toEqual([...BUILTIN_PYLON_PRODUCT_PLUGIN_IDS].sort())
  })
})
