import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { TitlebarRegistry } from '../titlebarRegistry.ts'

const Button = () => null

describe('TitlebarRegistry', () => {
  it('keeps transaction isolation, caller ordering and shadow revert', () => {
    const registry = new TitlebarRegistry()
    const owner = createPluginIdentity('test.titlebar', 'old')
    const value = { id: 'view-id', slot: 'app-actions' as const, label: 'Action',
      renderKind: 'first-party-react' as const, component: Button }
    const transaction = registry.beginTransaction(owner)
    transaction.register(value, { contributionId: 'entry-id', priority: 0, layer: 'override' })
    expect(registry.getSnapshot().entries).toEqual([])
    transaction.commit()
    const before = registry.getSnapshot()
    expect(before.entries[0]).toMatchObject({ contributionId: 'entry-id', priority: 0, layer: 'override', value })
    const next = createPluginIdentity('test.titlebar', 'next')
    const shadow = registry.beginShadowTransaction(next, owner.key)
    shadow.register({ ...value, label: 'Next' }, { contributionId: 'entry-id' })
    expect(registry.getSnapshot()).toBe(before)
    shadow.commit()
    expect(registry.getSnapshot().entries[0].value.label).toBe('Next')
    shadow.revert()
    expect(registry.getSnapshot().entries).toEqual(before.entries)
  })

  it('publishes ordered contributions and disposes them', () => {
    const registry = new TitlebarRegistry()
    const owner = createPluginIdentity('test.titlebar', 'run-1')
    const first = registry.register(owner, { id: 'first', slot: 'app-actions', label: 'First', renderKind: 'first-party-react', component: Button }, { contributionId: 'first', priority: 100 })
    registry.register(owner, { id: 'second', slot: 'app-actions', label: 'Second', renderKind: 'first-party-react', component: Button }, { contributionId: 'second', priority: 200 })
    expect(registry.getSnapshot().entries.map(entry => entry.contributionId)).toEqual(['first', 'second'])
    first.dispose()
    expect(registry.getSnapshot().entries.map(entry => entry.contributionId)).toEqual(['second'])
  })
})
