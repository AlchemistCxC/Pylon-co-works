import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { PresetRegistry } from '../presetRegistry.ts'
import { createPluginPresetApi } from '../pluginPresetApi.ts'

describe('PresetRegistry', () => {
  it('registers, freezes and disposes contributions', async () => {
    const registry = new PresetRegistry()
    const identity = createPluginIdentity('test.preset', 'run-1')
    const scope = new PluginScope(identity.key)
    const api = createPluginPresetApi(registry, identity, scope)
    const first = api.registerPreset({ id: 'preset-a', label: 'A', payload: { mode: 'a' } })
    api.registerPreset({ id: 'preset-b', label: 'B', payload: {} })
    expect(registry.getSnapshot().entries).toHaveLength(2)
    expect(registry.getSnapshot().entries[0].value).toMatchObject({ id: 'preset-a' })
    expect(Object.isFrozen(registry.getSnapshot().entries[0].value)).toBe(true)
    first.dispose()
    expect(registry.getSnapshot().entries).toHaveLength(1)
    await scope.dispose()
    expect(registry.getSnapshot().entries).toEqual([])
  })

  it('rejects empty or padded ids and empty labels', () => {
    const registry = new PresetRegistry()
    const owner = createPluginIdentity('test.preset', 'run-1')
    expect(() => registry.register(owner, { id: '', label: 'A', payload: {} })).toThrow('Preset id 不能为空')
    expect(() => registry.register(owner, { id: ' padded', label: 'A', payload: {} })).toThrow('Preset id 不能为空')
    expect(() => registry.register(owner, { id: 'blank-label', label: '   ', payload: {} })).toThrow('Preset label 不能为空：blank-label')
    registry.register(owner, { id: 'valid', label: 'A', payload: {} })
    expect(registry.getSnapshot().entries).toHaveLength(1)
  })

  it('resolves a contribution by id', () => {
    const registry = new PresetRegistry()
    const owner = createPluginIdentity('test.preset', 'run-1')
    registry.register(owner, { id: 'preset-a', label: 'A', payload: {} })
    expect(registry.resolve('preset-a')?.value.label).toBe('A')
    expect(registry.resolve('missing')).toBeUndefined()
  })
})
