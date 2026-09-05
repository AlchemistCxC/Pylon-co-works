import { describe, expect, it } from 'vitest'
import {
  parsePylonPluginManifest,
  PluginManifestError,
  PYLON_PLUGIN_API_VERSION,
  PYLON_PLUGIN_CAPABILITIES,
} from '../packageManifest.ts'

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

  it('rejects unsupported dependency ranges with a stable manifest error', () => {
    expect(() => parsePylonPluginManifest({
      ...valid,
      dependencies: { 'service.clock': '>=1.0.0' },
    })).toThrow(expect.objectContaining<Partial<PluginManifestError>>({
      name: 'PluginManifestError',
      code: 'plugin_manifest_invalid',
      field: 'dependencies.service.clock',
    }))
  })

  it('rejects invalid dependency ids before contract resolution', () => {
    expect(() => parsePylonPluginManifest({
      ...valid,
      dependencies: { 'Not A Plugin': '*' },
    })).toThrow(expect.objectContaining<Partial<PluginManifestError>>({
      code: 'plugin_manifest_invalid',
      field: 'dependencies.Not A Plugin',
    }))
  })

  it('rejects self-conflicts with a stable field diagnostic', () => {
    expect(() => parsePylonPluginManifest({
      ...valid,
      conflicts: ['feature.example'],
    })).toThrow(expect.objectContaining<Partial<PluginManifestError>>({
      code: 'plugin_manifest_invalid',
      field: 'conflicts.0',
    }))
  })

  it('rejects empty or duplicate activation events', () => {
    expect(() => parsePylonPluginManifest({
      ...valid,
      activation: { events: ['kernel.ready', 'kernel.ready'] },
    })).toThrow(expect.objectContaining<Partial<PluginManifestError>>({
      code: 'plugin_manifest_invalid',
      field: 'activation.events',
    }))
  })
})

describe('api=1.2 package manifest (capabilities)', () => {
  const v12 = { ...valid, api: '1.2' as const }

  it('accepts a legal capabilities declaration', () => {
    const manifest = parsePylonPluginManifest({ ...v12, capabilities: ['plugin.management'] })
    expect(manifest.capabilities).toEqual(['plugin.management'])
  })

  it('accepts 1.2 without capabilities (field is optional)', () => {
    expect(parsePylonPluginManifest(v12)).toEqual(v12)
  })

  it('rejects an unknown capability (fail-closed vocabulary)', () => {
    expect(() => parsePylonPluginManifest({ ...v12, capabilities: ['plugin.filesystem'] }))
      .toThrow(expect.objectContaining<Partial<PluginManifestError>>({
        code: 'plugin_manifest_invalid',
        field: 'capabilities.0',
      }))
  })

  it('rejects duplicate capabilities', () => {
    expect(() => parsePylonPluginManifest({
      ...v12,
      capabilities: ['plugin.management', 'plugin.management'],
    })).toThrow(expect.objectContaining<Partial<PluginManifestError>>({
      code: 'plugin_manifest_invalid',
      field: 'capabilities.1',
    }))
  })

  it('rejects non-string or empty capability entries', () => {
    expect(() => parsePylonPluginManifest({ ...v12, capabilities: ['  '] }))
      .toThrow(expect.objectContaining<Partial<PluginManifestError>>({
        code: 'plugin_manifest_invalid',
        field: 'capabilities',
      }))
    expect(() => parsePylonPluginManifest({ ...v12, capabilities: 'plugin.management' }))
      .toThrow(/capabilities/)
  })

  it('rejects capabilities on api=1.1 manifests (version-aware removed-field rule)', () => {
    expect(() => parsePylonPluginManifest({ ...valid, api: '1.1', capabilities: ['plugin.management'] }))
      .toThrow(/capabilities.*API 1\.0/)
  })

  it('keeps the vocabulary closed and exported', () => {
    expect(PYLON_PLUGIN_CAPABILITIES).toEqual(['plugin.management'])
  })

  it('rejects api=1.3 as an unsupported version', () => {
    expect(() => parsePylonPluginManifest({ ...v12, api: '1.3' })).toThrow(/仅支持/)
  })
})
