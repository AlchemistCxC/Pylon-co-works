import { describe, expect, it } from 'vitest'
import {
  BUILTIN_SOLID_CONTENT_KINDS,
  createBuiltinSolidRendererSuite,
} from '../builtinSolidRendererSuite.ts'

describe('C13 built-in Solid Suite declaration', () => {
  it('declares every lifecycle and system kind supported by its base Slot', () => {
    const suite = createBuiltinSolidRendererSuite()
    const lifecycleKinds = BUILTIN_SOLID_CONTENT_KINDS.filter(kind => kind.startsWith('lifecycle.') || kind.startsWith('system.'))
    expect(suite.optionalKinds).toEqual(expect.arrayContaining(lifecycleKinds))
  })
})
