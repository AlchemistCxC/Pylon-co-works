import { describe, expect, it } from 'vitest'
import { createBuiltinCcWidgetPluginDefinition } from '../builtinCcWidgetPlugin.ts'
import { TestPluginRuntime } from '../../../../plugin-runtime/testing/pluginRuntimeHarness.ts'
import { getRuntimeServices } from '../../../../plugin-runtime/runtimeServices.ts'

describe('builtin cc widget plugin', () => {
  it('registers only the builtin body surface on activation', async () => {
    const runtime = new TestPluginRuntime()
    const instance = await runtime.activateBuiltin(createBuiltinCcWidgetPluginDefinition())
    expect(getRuntimeServices().ccWidgetRegistry.getSnapshot().entries).toHaveLength(1)
    expect(getRuntimeServices().ccWidgetRegistry.getSnapshot().entries[0].value.id).toBe('cc-surface')
    await runtime.deactivate(instance.identity.key)
    expect(getRuntimeServices().ccWidgetRegistry.getSnapshot().entries).toHaveLength(0)
  })
})
