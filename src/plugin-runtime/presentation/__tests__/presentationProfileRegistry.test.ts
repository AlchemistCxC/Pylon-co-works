import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { createPluginPresentationApi } from '../pluginPresentationApi.ts'
import { PresentationProfileRegistry } from '../presentationProfileRegistry.ts'

describe('PresentationProfileRegistry', () => {
  it('按 order 发布、校验主题 token，并随 scope 回收', async () => {
    const registry = new PresentationProfileRegistry()
    const owner = createPluginIdentity('test.presentation', 'run-1')
    const scope = new PluginScope(owner.key)
    const api = createPluginPresentationApi(registry, owner, scope)

    api.registerProfile({ id: 'late', label: 'Late', family: 'terminal', order: 200, tokens: { msgStyle: 'terminal' } })
    api.registerProfile({ id: 'early', label: 'Early', family: 'gui', order: 100, tokens: { msgStyle: 'bubble' } })
    expect(registry.getSnapshot().entries.map(entry => entry.contributionId)).toEqual(['early', 'late'])
    expect(() => api.registerProfile({ id: 'bad', label: 'Bad', family: 'custom', tokens: { missingToken: true } })).toThrow(/未知/)

    await scope.dispose()
    expect(registry.getSnapshot().entries).toEqual([])
  })

  it('shadow transaction 原子替换 profile 并支持 revert', () => {
    const registry = new PresentationProfileRegistry()
    const oldOwner = createPluginIdentity('test.presentation', 'old')
    const nextOwner = createPluginIdentity('test.presentation', 'next')
    registry.register(oldOwner, { id: 'shared', label: 'Old', family: 'terminal', tokens: { msgStyle: 'terminal' } })
    const transaction = registry.beginShadowTransaction(nextOwner, oldOwner.key)
    transaction.register({ id: 'shared', label: 'Next', family: 'gui', tokens: { msgStyle: 'bubble' } }, { contributionId: 'ignored' })
    transaction.commit()
    expect(registry.resolve('shared')?.value.label).toBe('Next')
    transaction.revert()
    expect(registry.resolve('shared')?.value.label).toBe('Old')
  })
})

