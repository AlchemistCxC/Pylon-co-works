import { describe, expect, it } from 'vitest'
import { parseSettingsTarget, stringifySettingsTarget } from '../settingsTargetGrammar.ts'

describe('settings target grammar', () => {
  it('round-trips structured targets with dotted owner and field', () => {
    const target = { namespace: 'kind' as const, ownerId: 'acme.widgets.chart', fieldKey: 'status.color' }
    expect(parseSettingsTarget(stringifySettingsTarget(target))).toEqual(target)
  })

  it('fails closed for ambiguous or unknown legacy targets', () => {
    expect(parseSettingsTarget('kind.only-two')).toBeUndefined()
    expect(parseSettingsTarget('unknown.owner.field')).toBeUndefined()
    expect(parseSettingsTarget('kind.owner.')).toBeUndefined()
  })
})
