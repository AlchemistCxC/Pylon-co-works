import { describe, expect, it } from 'vitest'
import { parseSettingsTarget, stringifySettingsTarget } from '../settingsTargetGrammar.ts'

describe('settings target grammar', () => {
  it('round-trips structured targets with dotted owner and field', () => {
    const target = { namespace: 'kind' as const, ownerId: 'acme.widgets.chart', fieldKey: 'status.color' }
    expect(parseSettingsTarget(stringifySettingsTarget(target))).toEqual(target)
  })

  it('round-trips ownerPluginId without changing canonical segments', () => {
    const target = { namespace: 'kind' as const, ownerPluginId: 'plugin.acme', ownerId: 'acme.widgets.chart', fieldKey: 'status.color' }
    const encoded = stringifySettingsTarget(target)
    expect(encoded).toBe('kind.plugin%2Eacme.acme%2Ewidgets%2Echart.status%2Ecolor')
    expect(parseSettingsTarget(encoded)).toEqual(target)
  })

  it('keeps Theme targets on the legacy-compatible two-segment wire form', () => {
    const target = { namespace: 'theme' as const, ownerId: 'theme', fieldKey: 'accent' }
    expect(stringifySettingsTarget(target)).toBe('theme.accent')
    expect(parseSettingsTarget('theme.accent')).toEqual(target)
    expect(parseSettingsTarget('theme.theme.accent')).toBeUndefined()
  })

  it('fails closed for ambiguous or unknown legacy targets', () => {
    expect(parseSettingsTarget('kind.only-two')).toBeUndefined()
    expect(parseSettingsTarget('unknown.owner.field')).toBeUndefined()
    expect(parseSettingsTarget('kind.owner.')).toBeUndefined()
  })
})
