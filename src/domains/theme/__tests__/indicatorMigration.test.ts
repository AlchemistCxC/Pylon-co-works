import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '../themeDefaults.ts'
import { PRESET_ZONES } from '../presetReducer.ts'
import { normalizeThemeMigrationState, themeDomainMigrate } from '../migration.ts'
import { normalizeCustomPresets } from '../../../customPresets.ts'

describe('tool indicator migration', () => {
  it('maps a legacy single glyph to all three semantic states', () => {
    const migrated = themeDomainMigrate({ toolIndicator: 'star' }, {
      base: DEFAULTS,
      appliedPreset: Object.fromEntries(PRESET_ZONES.map(zone => [zone, ''])),
      custom: Object.fromEntries(PRESET_ZONES.map(zone => [zone, false])),
      ccLayout: DEFAULTS.ccLayout,
    }, 7)
    expect(migrated.toolIndicatorRun).toBe('star')
    expect(migrated.toolIndicatorOk).toBe('star')
    expect(migrated.toolIndicatorErr).toBe('star')
  })

  it('preserves legacy glyphs inside saved custom presets', () => {
    const [preset] = normalizeCustomPresets([{ id: 'legacy', name: '旧主题', theme: { toolIndicator: 'diamond' } }])
    expect(preset?.theme.toolIndicatorRun).toBe('diamond')
    expect(preset?.theme.toolIndicatorOk).toBe('diamond')
    expect(preset?.theme.toolIndicatorErr).toBe('diamond')
  })

  it('keeps the custom preset and bundle identities aligned during migration', () => {
    const [preset] = normalizeCustomPresets([{
      id: 'legacy-id', name: '  我的主题  ', theme: { accent: '#abc' }, createdAt: 20, updatedAt: 21,
      bundle: {
        manifestVersion: 2,
        id: 'old-bundle-id',
        name: '旧名称',
        source: 'user',
        createdAt: 2,
        updatedAt: 3,
        contributions: {
          'builtin.theme': {
            ownerPluginId: 'builtin.pylon-shell', providerVersion: 1,
            policy: 'complete', payload: { accent: '#abc' },
          },
        },
      },
    }])
    expect(preset?.id).toBe('custom-legacy-id')
    expect(preset?.name).toBe('我的主题')
    expect(preset?.bundle?.id).toBe('custom-legacy-id')
    expect(preset?.bundle?.name).toBe('我的主题')
    expect(preset?.createdAt).toBe(20)
    expect(preset?.updatedAt).toBe(21)
    expect(preset?.bundle?.createdAt).toBe(20)
    expect(preset?.bundle?.updatedAt).toBe(21)
  })

  it('rewrites persisted zone references when a legacy custom id is namespaced', () => {
    const appliedPreset = Object.fromEntries(PRESET_ZONES.map(zone => [zone, '']))
    const custom = Object.fromEntries(PRESET_ZONES.map(zone => [zone, false]))
    appliedPreset.chat = 'legacy-id'
    const migrated = normalizeThemeMigrationState({
      appliedPreset,
      custom,
      customPresets: [{ id: 'legacy-id', name: '旧主题', theme: { accent: '#abc' } }],
    }, {
      base: DEFAULTS,
      appliedPreset,
      custom,
      ccLayout: DEFAULTS.ccLayout,
    })
    expect((migrated.appliedPreset as Record<string, string>).chat).toBe('custom-legacy-id')
  })

  it('rewrites references when the persisted custom id contains whitespace', () => {
    const appliedPreset = Object.fromEntries(PRESET_ZONES.map(zone => [zone, '']))
    const custom = Object.fromEntries(PRESET_ZONES.map(zone => [zone, false]))
    appliedPreset.chat = 'legacy-id'
    const migrated = normalizeThemeMigrationState({
      appliedPreset,
      custom,
      customPresets: [{ id: '  legacy-id  ', name: '旧主题', theme: { accent: '#abc' } }],
    }, {
      base: DEFAULTS,
      appliedPreset,
      custom,
      ccLayout: DEFAULTS.ccLayout,
    })
    expect((migrated.appliedPreset as Record<string, string>).chat).toBe('custom-legacy-id')
  })
})
