import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { InterfaceModeRegistry } from '../interfaceModeRegistry.ts'
import { createPluginInterfaceModeApi } from '../pluginInterfaceModeApi.ts'

const mode = (label: string) => ({
  id: 'example.focus',
  label,
  description: 'Example full mode',
  defaultPresentationProfileId: 'example.presentation.focus',
  chromeStyle: 'icons' as const,
  workbench: { renderKind: 'isolated-surface' as const, surfaceId: 'example.focus.workbench' },
  shellSurface: { surfaceId: 'example.focus.shell', placement: 'overlay' as const },
})

describe('InterfaceModeRegistry', () => {
  it('允许插件注册结构化完整模式，并随 scope 回收', async () => {
    const registry = new InterfaceModeRegistry()
    const owner = createPluginIdentity('example.focus', 'one')
    const scope = new PluginScope(owner.key)
    createPluginInterfaceModeApi(registry, owner, scope).registerMode(mode('Focus One'))
    expect(registry.resolve('example.focus')?.value).toMatchObject({
      chromeStyle: 'icons',
      workbench: { renderKind: 'isolated-surface', surfaceId: 'example.focus.workbench' },
      shellSurface: { placement: 'overlay' },
    })
    await scope.dispose()
    expect(registry.resolve('example.focus')).toBeUndefined()
  })

  it('shadow update 原子替换并可 revert', () => {
    const registry = new InterfaceModeRegistry()
    const oldOwner = createPluginIdentity('example.focus', 'old')
    registry.register(oldOwner, mode('Old'))
    const next = createPluginIdentity('example.focus', 'next')
    const transaction = registry.beginShadowTransaction(next, oldOwner.key)
    transaction.register(mode('Next'), { contributionId: 'ignored' })
    transaction.commit()
    expect(registry.resolve('example.focus')?.value.label).toBe('Next')
    transaction.revert()
    expect(registry.resolve('example.focus')?.value.label).toBe('Old')
  })

  it('拒绝非法 id、空默认 Profile 与不完整 Surface workbench', () => {
    const registry = new InterfaceModeRegistry()
    const owner = createPluginIdentity('example.invalid', 'one')
    expect(() => registry.register(owner, { ...mode('Bad'), id: 'Bad Mode' })).toThrow(/id 非法/)
    expect(() => registry.register(owner, { ...mode('Bad'), defaultPresentationProfileId: '' })).toThrow(/defaultPresentationProfileId/)
    expect(() => registry.register(owner, {
      ...mode('Bad'),
      workbench: { renderKind: 'isolated-surface', surfaceId: '' },
    })).toThrow(/surfaceId/)
  })
})

