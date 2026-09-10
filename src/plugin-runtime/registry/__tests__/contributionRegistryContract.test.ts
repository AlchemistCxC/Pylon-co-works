import { describe, expect, it, vi } from 'vitest'
import { FontContributionRegistry } from '../../fonts/fontContributionRegistry.ts'
import type { FontContribution } from '../../fonts/fontContributionTypes.ts'
import { InterfaceModeRegistry } from '../../interface-mode/interfaceModeRegistry.ts'
import type { InterfaceModeContribution } from '../../interface-mode/interfaceModeTypes.ts'
import { PresentationProfileRegistry } from '../../presentation/presentationProfileRegistry.ts'
import type { PresentationProfileContribution } from '../../presentation/presentationProfileTypes.ts'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import type { ValidatedContributionRegistry } from '../validatedContributionRegistry.ts'

type Contribution = { id: string; label: string; order?: number }
type Registry<T extends Contribution> = Pick<ValidatedContributionRegistry<T>,
  'register' | 'beginShadowTransaction' | 'getSnapshot' | 'subscribe' | 'resolve'>

function registryContract<T extends Contribution>(
  name: string,
  createRegistry: () => Registry<T>,
  contribution: (id: string, label: string, order?: number) => T,
) {
  describe(name, () => {
    const oldOwner = createPluginIdentity('test.contributions', 'old')
    const nextOwner = createPluginIdentity('test.contributions', 'next')
    const foreignOwner = createPluginIdentity('test.foreign', 'other')

    it('rejects invalid live and staged contributions without publishing', () => {
      const registry = createRegistry()
      registry.register(oldOwner, contribution('shared', 'Old'))
      const before = registry.getSnapshot()
      const listener = vi.fn()
      registry.subscribe(listener)
      expect(() => registry.register(foreignOwner, contribution('invalid', ''))).toThrow(/label/)
      const transaction = registry.beginShadowTransaction(nextOwner, oldOwner.key)
      expect(() => transaction.register(contribution('shared', ''), { contributionId: 'shared' })).toThrow(/label/)
      transaction.register(contribution('shared', 'Next'), { contributionId: 'shared' })
      transaction.validate()
      transaction.rollback()
      expect(registry.getSnapshot()).toBe(before)
      expect(listener).not.toHaveBeenCalled()
    })

    it('keeps normalized identity/order and caller constraints during replacement', () => {
      const registry = createRegistry()
      registry.register(oldOwner, contribution('shared', 'Old'))
      registry.register(foreignOwner, contribution('foreign', 'Foreign', 10))
      const foreign = registry.resolve('foreign')
      const transaction = registry.beginShadowTransaction(nextOwner, oldOwner.key)
      const staged = contribution('shared', 'Next', 70)
      transaction.register(staged, {
        contributionId: 'ignored', priority: -100, layer: 'feature', before: ['foreign'],
      })
      transaction.validate()
      expect(registry.resolve('shared')?.value.label).toBe('Old')
      transaction.commit()
      expect(registry.getSnapshot().entries.map(entry => entry.contributionId)).toEqual(['shared', 'foreign'])
      expect(registry.resolve('shared')).toMatchObject({
        priority: 70, layer: 'feature', before: ['foreign'], ownerRuntimeInstanceId: nextOwner.key,
      })
      expect(registry.resolve('shared')?.value).not.toBe(staged)
      expect(Object.isFrozen(registry.resolve('shared')?.value)).toBe(true)
      expect(registry.resolve('ignored')).toBeUndefined()
      expect(registry.resolve('foreign')).toBe(foreign)
    })

    it('restores original entries on revert and ignores disposal of the reverted replacement', async () => {
      const registry = createRegistry()
      registry.register(oldOwner, contribution('shared', 'Old'))
      registry.register(foreignOwner, contribution('foreign', 'Foreign'))
      const before = registry.getSnapshot().entries
      const transaction = registry.beginShadowTransaction(nextOwner, oldOwner.key)
      const replacement = transaction.register(contribution('shared', 'Next'), { contributionId: 'ignored' })
      transaction.commit()
      transaction.revert()
      await replacement.dispose()
      expect(registry.getSnapshot().entries).toEqual(before)
      expect(registry.resolve('shared')).toBe(before.find(entry => entry.contributionId === 'shared'))
    })

    it('isolates old/staged disposables and stops notifications after unsubscribe', async () => {
      const registry = createRegistry()
      const old = registry.register(oldOwner, contribution('shared', 'Old'))
      registry.register(foreignOwner, contribution('foreign', 'Foreign'))
      const listener = vi.fn()
      const unsubscribe = registry.subscribe(listener)
      const transaction = registry.beginShadowTransaction(nextOwner, oldOwner.key)
      const cancelled = transaction.register(contribution('cancelled', 'Cancelled'), { contributionId: 'cancelled' })
      await cancelled.dispose()
      const replacement = transaction.register(contribution('shared', 'Next'), {
        contributionId: 'shared', layer: 'override', after: ['foreign'],
      })
      transaction.commit()
      await old.dispose()
      expect(registry.resolve('shared')).toMatchObject({ layer: 'override', after: ['foreign'] })
      expect(registry.resolve('cancelled')).toBeUndefined()
      expect(listener).toHaveBeenCalledTimes(1)
      unsubscribe()
      await replacement.dispose()
      await replacement.dispose()
      expect(registry.getSnapshot().entries.map(entry => entry.contributionId)).toEqual(['foreign'])
      expect(listener).toHaveBeenCalledTimes(1)
    })
  })
}

registryContract<FontContribution>('FontContributionRegistry contract', () => new FontContributionRegistry(),
  (id, label, order) => ({ id, label, order, family: 'sans-serif', roles: ['content'] }))
registryContract<InterfaceModeContribution>('InterfaceModeRegistry contract', () => new InterfaceModeRegistry(),
  (id, label, order) => ({
    id, label, order, description: 'Test mode', defaultPresentationProfileId: 'test.profile',
    chromeStyle: 'icons', workbench: { renderKind: 'host', renderer: 'modern' },
  }))
registryContract<PresentationProfileContribution>('PresentationProfileRegistry contract', () => new PresentationProfileRegistry(),
  (id, label, order) => ({ id, label, order, family: 'terminal', tokens: { msgStyle: 'terminal' } }))
