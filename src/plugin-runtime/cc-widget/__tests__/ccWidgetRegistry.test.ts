import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { CcWidgetRegistry } from '../ccWidgetRegistry.ts'
import { createPluginCcWidgetApi } from '../pluginCcWidgetApi.ts'

describe('CcWidgetRegistry', () => {
  it('registers, freezes and disposes contributions', async () => {
    const registry = new CcWidgetRegistry()
    const identity = createPluginIdentity('test.cc', 'run-1')
    const scope = new PluginScope(identity.key)
    const api = createPluginCcWidgetApi(registry, identity, scope)
    const first = api.registerWidget({ id: 'widget-a', label: 'A', render: { kind: 'host-renderer', rendererKey: 'a' } })
    api.registerWidget({ id: 'widget-b', label: 'B' })
    expect(registry.getSnapshot().entries).toHaveLength(2)
    expect(registry.getSnapshot().entries[0].value).toMatchObject({ id: 'widget-a' })
    expect(Object.isFrozen(registry.getSnapshot().entries[0].value)).toBe(true)
    first.dispose()
    expect(registry.getSnapshot().entries).toHaveLength(1)
    await scope.dispose()
    expect(registry.getSnapshot().entries).toEqual([])
  })

  it('rejects duplicate ids and invalid render specs', () => {
    const registry = new CcWidgetRegistry()
    const owner = createPluginIdentity('test.cc', 'run-1')
    registry.register(owner, { id: 'same', label: 'A' })
    expect(() => registry.register(owner, { id: 'same', label: 'B' })).toThrow()
    expect(() => registry.register(owner, { id: 'bad', label: 'B', render: { kind: 'isolated-surface', surfaceId: '' } })).toThrow()
  })
})
