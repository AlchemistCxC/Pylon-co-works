import { describe, expect, it } from 'vitest'
import { createBuiltinPresetPluginDefinition } from '../builtinPresetPlugin.ts'
import { TestPluginRuntime } from '../../../../plugin-runtime/testing/pluginRuntimeHarness.ts'
import { getRuntimeServices } from '../../../../plugin-runtime/runtimeServices.ts'
import type { BuiltinPluginDefinition } from '../../../../plugin-runtime/pluginRuntime.ts'

describe('builtin preset plugin', () => {
  it('激活不注册预设，卸载后快照仍为空', async () => {
    const runtime = new TestPluginRuntime()
    const instance = await runtime.activateBuiltin(createBuiltinPresetPluginDefinition())
    try {
      expect(getRuntimeServices().presetRegistry.getSnapshot().entries).toHaveLength(0)
    } finally {
      await runtime.deactivate(instance.identity.key)
    }
    expect(getRuntimeServices().presetRegistry.getSnapshot().entries).toHaveLength(0)
  })

  it('激活期注册的预设可从快照读回，并在卸载后回收', async () => {
    const runtime = new TestPluginRuntime()
    const probe: BuiltinPluginDefinition = {
      id: 'test.preset-probe',
      kind: 'feature',
      firstParty: true,
      hotSwapMode: 'parallel',
      activate: context => {
        context.presets.registerPreset({
          id: 'probe-preset',
          label: '探针预设',
          scope: 'probe-mode',
          payload: { source: 'probe' },
        })
      },
    }
    const instance = await runtime.activateBuiltin(probe)
    try {
      const entries = getRuntimeServices().presetRegistry.getSnapshot().entries
      expect(entries).toHaveLength(1)
      expect(entries[0].ownerPluginId).toBe('test.preset-probe')
      expect(entries[0].value).toMatchObject({
        id: 'probe-preset',
        label: '探针预设',
        scope: 'probe-mode',
        payload: { source: 'probe' },
      })
    } finally {
      await runtime.deactivate(instance.identity.key)
    }
    expect(getRuntimeServices().presetRegistry.getSnapshot().entries).toHaveLength(0)
  })
})
