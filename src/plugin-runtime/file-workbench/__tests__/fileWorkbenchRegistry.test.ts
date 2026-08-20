import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { FileWorkbenchRegistry } from '../fileWorkbenchRegistry.ts'
import { createPluginFileWorkbenchApi } from '../pluginFileWorkbenchApi.ts'

const Component = () => null
const activity = (id: string) => ({ kind: 'activity' as const, id, label: id, description: id, order: 1, icon: 'files' as const, renderKind: 'first-party-react' as const, component: Component })

describe('FileWorkbenchRegistry lifecycle', () => {
  it('PluginScope dispose removes owner contributions', async () => {
    const registry = new FileWorkbenchRegistry()
    const identity = createPluginIdentity('test.file', 'one')
    const scope = new PluginScope(identity.key)
    createPluginFileWorkbenchApi(registry, identity, scope).register(activity('test.activity'))
    expect(registry.getSnapshot().entries).toHaveLength(1)
    await scope.dispose()
    expect(registry.getSnapshot().entries).toHaveLength(0)
  })

  it('shadow commit replaces old runtime atomically and rollback preserves it', () => {
    const registry = new FileWorkbenchRegistry()
    const old = createPluginIdentity('test.file', 'old')
    registry.register(old, activity('old.activity'))
    const next = createPluginIdentity('test.file', 'next')
    const rollback = registry.beginShadowTransaction(next, old.key)
    rollback.register(activity('next.activity'), { contributionId: 'next.activity' })
    rollback.rollback()
    expect(registry.getSnapshot().entries.map(entry => entry.contributionId)).toEqual(['old.activity'])
    const commit = registry.beginShadowTransaction(next, old.key)
    commit.register(activity('next.activity'), { contributionId: 'next.activity' })
    commit.commit()
    expect(registry.getSnapshot().entries.map(entry => entry.contributionId)).toEqual(['next.activity'])
  })
})
