import { describe, expect, it, vi } from 'vitest'
import { bootstrapPluginDefinitions } from '../builtinPluginBootstrap.ts'
import { TestPluginRuntime as PluginRuntime } from '../testing/pluginRuntimeHarness.ts'

describe('Builtin plugin bootstrap', () => {
  it('continues unrelated plugins and skips dependents after one activation failure', async () => {
    const unrelated = vi.fn()
    const dependent = vi.fn()
    const runtime = new PluginRuntime()

    const result = await bootstrapPluginDefinitions(runtime, [
      {
        id: 'product.base',
        criticality: 'product-required',
        activate: () => { throw new Error('base boom') },
      },
      {
        id: 'product.dependent',
        dependencies: ['product.base'],
        criticality: 'product-required',
        activate: dependent,
      },
      {
        id: 'product.unrelated',
        criticality: 'optional',
        activate: unrelated,
      },
    ], 'normal')

    expect(unrelated).toHaveBeenCalledOnce()
    expect(dependent).not.toHaveBeenCalled()
    expect(result.activePluginIds).toEqual(['product.unrelated'])
    expect(result.skippedPluginIds).toEqual(['product.dependent'])
    expect(result.failures).toEqual([
      expect.objectContaining({ pluginId: 'product.base', stage: 'activate', code: 'plugin_activation_failed' }),
      expect.objectContaining({ pluginId: 'product.dependent', stage: 'dependency', code: 'dependency_failed' }),
    ])
  })

  it('deactivates already-running product plugins when entering safe mode', async () => {
    const runtime = new PluginRuntime()
    const definition = {
      id: 'product.running',
      criticality: 'product-required' as const,
      activate: vi.fn(),
    }
    await runtime.activateBuiltin(definition)

    const result = await bootstrapPluginDefinitions(runtime, [definition], 'safe-mode')

    expect(runtime.snapshot().active).toEqual([])
    expect(result).toEqual({
      activePluginIds: [],
      failures: [],
      skippedPluginIds: ['product.running'],
    })
  })
})
