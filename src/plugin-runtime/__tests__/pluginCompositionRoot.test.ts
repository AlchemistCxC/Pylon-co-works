import { describe, expect, it, vi } from 'vitest'

describe('Plugin composition root bootstrap boundary', () => {
  it('importing the composition root does not activate plugins', async () => {
    vi.resetModules()

    const composition = await import('../pluginCompositionRoot.ts')

    expect(composition.getPluginRuntime().snapshot().active).toEqual([])
  })

  it('activates builtins only through the explicit normal bootstrap action', async () => {
    vi.resetModules()
    const composition = await import('../pluginCompositionRoot.ts')

    const result = await composition.bootstrapBuiltins('normal')

    expect(result.failures).toEqual([])
    expect(result.activePluginIds).toEqual(composition.getBuiltinPluginIds())
    expect(composition.getPluginRuntime().snapshot().active.map(item => item.pluginId).sort())
      .toEqual(composition.getBuiltinPluginIds())
  })

  it('safe mode deactivates user and product plugin instances without changing package intent', async () => {
    vi.resetModules()
    const composition = await import('../pluginCompositionRoot.ts')
    await composition.bootstrapBuiltins('normal')
    await composition.getPluginRuntime().activateBuiltin({
      id: 'user.safe-mode-fixture',
      activate: () => undefined,
    })

    const result = await composition.bootstrapBuiltins('safe-mode')

    expect(composition.getPluginRuntime().snapshot().active).toEqual([])
    expect(result.skippedPluginIds).toEqual(composition.getBuiltinPluginIds())
  })

  it('safe-mode shell selection activates its full dependency closure but leaves unrelated builtins skipped', async () => {
    vi.resetModules()
    const composition = await import('../pluginCompositionRoot.ts')
    await composition.bootstrapBuiltins('safe-mode')

    const result = await composition.retryBuiltinPlugin('builtin.pylon-shell')

    expect(result.activePluginIds).toEqual([
      'builtin.pylon-agent-adapters',
      'builtin.pylon-renderers',
      'builtin.pylon-shell',
      'builtin.pylon-tools',
      'builtin.pylon-workspace',
    ])
    expect(result.skippedPluginIds).toEqual(['builtin.skin'])
  })
})
