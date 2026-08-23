import { describe, expect, it } from 'vitest'
import { BUILTIN_INTERACTION_RENDER_KINDS } from '../interactionRenderKindCatalog.ts'

describe('C12 interaction render settings contract', () => {
  it('declares only non-sensitive OAuth/Secret/Sudo presentation settings', () => {
    const oauth = BUILTIN_INTERACTION_RENDER_KINDS.find(kind => kind.id === 'interaction.oauth')!
    const keys = oauth.settings!.groups.flatMap(group => group.fields.map(field => field.key))
      .filter((key): key is string => typeof key === 'string')
    expect(keys).toEqual(expect.arrayContaining([
      'presentation', 'maxWidth', 'warningColor', 'showProviderMetadata', 'countdownStyle',
    ]))
    expect(keys.some(key => /remember|secret|credential|password/i.test(key))).toBe(false)
  })
})
