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

    // P53 D2（施工书 §6 例外 1）：管理器包声明 plugin.management，未授权时
    // normal bootstrap 进 capability-consent 可重试失败（同意流），其余五包正常激活
    expect(result.failures).toEqual([
      expect.objectContaining({
        pluginId: 'builtin.pylon-plugin-manager',
        stage: 'capability-consent',
        code: 'plugin_capability_denied',
        retryable: true,
      }),
    ])
    const expectedActive = composition.getBuiltinPluginIds()
      .filter(id => id !== 'builtin.pylon-plugin-manager')
    expect(result.activePluginIds).toEqual(expectedActive)
    expect(composition.getPluginRuntime().snapshot().active.map(item => item.pluginId).sort())
      .toEqual(expectedActive)
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

    // P53 D2（施工书 §6 例外 1 点名改写）：第 6 包 builtin.pylon-plugin-manager
    // 与 shell 闭包无依赖关系，safe-mode shell 选择下保持 skipped（其激活
    // 走 kernel.ready 正常 boot + capability 同意流）；builtin.skin skip 断言语义不变。
    expect(result.activePluginIds).toEqual([
      'builtin.pylon-agent-adapters',
      'builtin.pylon-renderers',
      'builtin.pylon-shell',
      'builtin.pylon-tools',
      'builtin.pylon-workspace',
    ])
    expect(result.skippedPluginIds).toEqual(['builtin.pylon-plugin-manager', 'builtin.skin'])
  })

  it('wires hook disable-plugin policy to the single product runtime', async () => {
    vi.resetModules()
    const composition = await import('../pluginCompositionRoot.ts')
    const { getHookRuntime } = await import('../runtimeServices.ts')
    await composition.getPluginRuntime().activateBuiltin({
      id: 'user.failing-hook',
      activate: ({ hooks }) => {
        hooks.register('turn.failed', {
          id: 'faulty-handler',
          mode: 'notification',
          failurePolicy: 'disable-plugin',
          handler: () => { throw new Error('handler failed') },
        })
      },
    })

    await getHookRuntime().invoke('turn.failed', {})

    expect(composition.getPluginRuntime().snapshot().active)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ pluginId: 'user.failing-hook' })]))
    expect(composition.getPluginRuntime().snapshot().instances)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({
        identity: expect.objectContaining({ pluginId: 'user.failing-hook' }),
      })]))
  })
})
