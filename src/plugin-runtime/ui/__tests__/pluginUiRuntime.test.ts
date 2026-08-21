import { describe, expect, it } from 'vitest'
import { resolvePluginUiRuntime } from '../pluginUiTypes.ts'
import { PluginUiRegistry } from '../pluginUiRegistry.ts'
import { createPluginIdentity } from '../../pluginIdentity.ts'

describe('Plugin UI runtime metadata', () => {
  it('accepts framework-neutral runtime metadata', () => {
    expect(resolvePluginUiRuntime({ runtime: { framework: 'solid', version: '1.9' } })).toEqual({
      runtime: { framework: 'solid', version: '1.9' }, deprecated: false,
    })
  })

  it('normalizes legacy reactVersion as a deprecated API 1.0 adapter', () => {
    expect(resolvePluginUiRuntime({ reactVersion: '19' })).toEqual({
      runtime: { framework: 'react', version: '19' }, deprecated: true,
    })
  })

  it('stores normalized runtime metadata in the registry while preserving legacy reads', () => {
    const registry = new PluginUiRegistry()
    const owner = createPluginIdentity('test.ui-runtime', 'legacy')
    registry.register(owner, { id: 'legacy.surface', reactVersion: '18', mount: () => undefined })
    expect(registry.getSnapshot().entries[0].value).toMatchObject({
      runtime: { framework: 'react', version: '18' }, reactVersion: '18',
    })
  })
})
