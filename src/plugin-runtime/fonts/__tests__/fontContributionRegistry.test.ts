import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { FontContributionRegistry, fontContributionCssVariable } from '../fontContributionRegistry.ts'
import { createPluginFontApi } from '../pluginFontApi.ts'

describe('FontContributionRegistry', () => {
  it('orders, validates and disposes plugin font contributions', async () => {
    const registry = new FontContributionRegistry()
    const owner = createPluginIdentity('test.fonts', 'run-1')
    const scope = new PluginScope(owner.key)
    const api = createPluginFontApi(registry, owner, scope)

    api.registerFont({ id: 'late.font', label: 'Late', family: 'Late, sans-serif', roles: ['interface'], order: 200 })
    api.registerFont({ id: 'early.font', label: 'Early', family: 'Early, monospace', roles: ['code'], order: 100 })
    expect(registry.getSnapshot().entries.map(entry => entry.contributionId)).toEqual(['early.font', 'late.font'])
    expect(fontContributionCssVariable('Vendor.Readable Font')).toBe('--pylon-font-vendor-readable-font')
    expect(() => api.registerFont({ id: 'bad', label: 'Bad', family: '', roles: ['content'] })).toThrow(/family/)

    await scope.dispose()
    expect(registry.getSnapshot().entries).toEqual([])
  })

  it('shadow transaction atomically replaces the owned font', () => {
    const registry = new FontContributionRegistry()
    const oldOwner = createPluginIdentity('test.fonts', 'old')
    const nextOwner = createPluginIdentity('test.fonts', 'next')
    registry.register(oldOwner, { id: 'shared', label: 'Old', family: 'Old', roles: ['content'] })
    const transaction = registry.beginShadowTransaction(nextOwner, oldOwner.key)
    transaction.register({ id: 'shared', label: 'Next', family: 'Next', roles: ['content'] }, { contributionId: 'ignored' })
    transaction.commit()
    expect(registry.resolve('shared')?.value.family).toBe('Next')
    transaction.revert()
    expect(registry.resolve('shared')?.value.family).toBe('Old')
  })
})

