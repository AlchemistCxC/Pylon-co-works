import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { ShellRecipeRegistry, validateShellRecipeContribution } from '../shellRecipeRegistry.ts'
import { createPluginShellRecipeApi } from '../pluginShellRecipeApi.ts'
import { DEFAULT_SHELL_RECIPE, type ShellRecipeContribution } from '../shellRecipeTypes.ts'

const recipe = (overrides: Partial<ShellRecipeContribution> = {}): ShellRecipeContribution => ({
  id: 'example.shell.mirrored',
  label: 'Mirrored Shell',
  sidebarSide: 'right',
  contextPanelSide: 'left',
  ...overrides,
})

describe('ShellRecipeRegistry', () => {
  it('允许插件注册 recipe 并随 scope 回收', () => {
    const registry = new ShellRecipeRegistry()
    const owner = createPluginIdentity('example.shell', 'one')
    const scope = new PluginScope(owner.key)
    createPluginShellRecipeApi(registry, owner, scope).registerRecipe(recipe())
    expect(registry.resolve('example.shell.mirrored')?.value).toMatchObject({
      sidebarSide: 'right',
      contextPanelSide: 'left',
    })
    void scope.dispose()
    expect(registry.resolve('example.shell.mirrored')).toBeUndefined()
  })

  it('shadow update 原子替换并可 revert', () => {
    const registry = new ShellRecipeRegistry()
    const oldOwner = createPluginIdentity('example.shell', 'old')
    registry.register(oldOwner, recipe({ label: 'Old' }))
    const next = createPluginIdentity('example.shell', 'next')
    const transaction = registry.beginShadowTransaction(next, oldOwner.key)
    transaction.register(recipe({ label: 'Next' }), { contributionId: 'ignored' })
    transaction.commit()
    expect(registry.resolve('example.shell.mirrored')?.value.label).toBe('Next')
    transaction.revert()
    expect(registry.resolve('example.shell.mirrored')?.value.label).toBe('Old')
  })

  it('校验逐例：id/label/order/side 枚举与两侧互斥', () => {
    expect(() => validateShellRecipeContribution(recipe({ id: 'Bad Recipe' }))).toThrow(/id 非法/)
    expect(() => validateShellRecipeContribution(recipe({ label: '' }))).toThrow(/label/)
    expect(() => validateShellRecipeContribution(recipe({ order: Number.NaN }))).toThrow(/order/)
    expect(() => validateShellRecipeContribution(recipe({ sidebarSide: 'center' as never }))).toThrow(/sidebarSide/)
    expect(() => validateShellRecipeContribution(recipe({ contextPanelSide: 'up' as never }))).toThrow(/contextPanelSide/)
    expect(() => validateShellRecipeContribution(recipe({ contextPanelSide: 'right' }))).toThrow(/不得同侧/)
    expect(validateShellRecipeContribution(DEFAULT_SHELL_RECIPE)).toMatchObject({
      id: 'builtin.shell.classic',
      sidebarSide: 'left',
      contextPanelSide: 'right',
    })
  })
})
