import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '../themeDefaults.ts'
import { PRESET_ZONES } from '../presetReducer.ts'
import { themeDomainMigrate } from '../migration.ts'
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
})
