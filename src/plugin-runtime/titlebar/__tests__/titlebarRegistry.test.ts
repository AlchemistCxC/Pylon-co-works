import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { TitlebarRegistry } from '../titlebarRegistry.ts'

const Button = () => null

describe('TitlebarRegistry', () => {
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
