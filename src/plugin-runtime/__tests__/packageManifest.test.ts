import { describe, expect, it } from 'vitest'
import { parsePylonPluginManifest, PYLON_PLUGIN_API_VERSION } from '../packageManifest.ts'

const valid = {
  schema: 1,
  id: 'feature.example',
  name: 'Example',
  version: '1.0.0',
  api: PYLON_PLUGIN_API_VERSION,
  kind: 'feature',
  web: { entry: './dist/entry.js', styles: ['./dist/style.css'] },
  dependencies: {},
  hotSwap: { mode: 'parallel', drainTimeoutMs: 10000 },
}

describe('api=1.0 package manifest', () => {
  it('accepts the schema-1 v2 shape', () => {
    expect(parsePylonPluginManifest(valid)).toEqual(valid)
  })

  it('rejects the deleted api=0.1 shape', () => {
    expect(() => parsePylonPluginManifest({
      id: 'legacy.example', api: '0.1.0', trust: 'dev', entry: 'index.js', capabilities: [], contributes: [],
    })).toThrow(/trust.*API 1\.0/)
  })

  it.each(['trust', 'capabilities', 'contributes', 'signature', 'entry'])(
    'rejects removed field %s even on a schema-1 manifest',
    removed => {
      expect(() => parsePylonPluginManifest({ ...valid, [removed]: 'legacy' }))
        .toThrow(new RegExp(`${removed}.*API 1\\.0`))
    },
  )
})
