import { describe, expect, it } from 'vitest'
import { createBuiltinCcWidgetPluginDefinition } from '../builtinCcWidgetPlugin.ts'
import { TestPluginRuntime } from '../../../../plugin-runtime/testing/pluginRuntimeHarness.ts'
import { getRuntimeServices } from '../../../../plugin-runtime/runtimeServices.ts'

describe('builtin cc widget plugin', () => {
  it('registers the builtin surface and send button on activation', async () => {
    const runtime = new TestPluginRuntime()
    const instance = await runtime.activateBuiltin(createBuiltinCcWidgetPluginDefinition())
    try {
      expect(getRuntimeServices().ccWidgetRegistry.getSnapshot().entries).toHaveLength(2)
      expect(getRuntimeServices().ccWidgetRegistry.getSnapshot().entries.map(entry => entry.value.id)).toEqual(['cc-send-button', 'cc-surface'])
    } finally {
      await runtime.deactivate(instance.identity.key)
    }
    expect(getRuntimeServices().ccWidgetRegistry.getSnapshot().entries).toHaveLength(0)
  })
})
