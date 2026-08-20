import { describe, expect, it, vi } from 'vitest'
import {
  definePlugin,
  PYLON_PLUGIN_API_VERSION,
  validatePluginManifest,
} from '../index.ts'

const manifest = {
  schema: 1 as const,
  id: 'feature.sdk-example',
  name: 'SDK example',
  version: '1.0.0',
  api: PYLON_PLUGIN_API_VERSION,
  kind: 'feature' as const,
  web: { entry: './dist/index.js' },
  dependencies: {},
  hotSwap: { mode: 'parallel' as const },
}

describe('Pylon API 1.0 SDK', () => {
  it('defines the package lifecycle without old contribution or trust declarations', async () => {
    const activate = vi.fn()
    const module = definePlugin({ activate })
    await module.activate({} as never)
    expect(activate).toHaveBeenCalledOnce()
    expect(Object.isFrozen(module)).toBe(true)
  })

  it('rejects an invalid lifecycle member', () => {
    expect(() => definePlugin({ activate: 'nope' } as never)).toThrow(/activate/)
    expect(() => definePlugin({ activate: () => undefined, deactivate: 'nope' } as never)).toThrow(/deactivate/)
  })

  it('validates only the API 1.0 manifest schema', () => {
    expect(validatePluginManifest(manifest)).toEqual(manifest)
    expect(() => validatePluginManifest({
      id: 'old.sdk', api: '0.1.0', trust: 'dev', capabilities: [], contributes: [],
    })).toThrow(/trust.*API 1\.0/)
  })
})
