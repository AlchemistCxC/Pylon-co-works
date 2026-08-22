import { describe, expect, it } from 'vitest'
import {
  BUILTIN_SOLID_CONTENT_KINDS,
  createBuiltinSolidRendererSuite,
} from '../builtinSolidRendererSuite.ts'
import { BUILTIN_TOOL_RENDER_KINDS } from '../../../domains/rendererContent/toolRenderKindCatalog.ts'

describe('C13 built-in Solid Suite declaration', () => {
  it('declares every lifecycle and system kind supported by its base Slot', () => {
    const suite = createBuiltinSolidRendererSuite()
    const lifecycleKinds = BUILTIN_SOLID_CONTENT_KINDS.filter(kind => kind.startsWith('lifecycle.') || kind.startsWith('system.'))
    expect(suite.optionalKinds).toEqual(expect.arrayContaining(lifecycleKinds))
  })
})

describe('C04 built-in Solid Suite declaration', () => {
  it('declares every generic tool lifecycle kind supported by its base Slot', () => {
    const suite = createBuiltinSolidRendererSuite()
    const toolKinds = BUILTIN_TOOL_RENDER_KINDS.map(kind => kind.id)

    expect(BUILTIN_SOLID_CONTENT_KINDS).toEqual(expect.arrayContaining(toolKinds))
    expect(suite.optionalKinds).toEqual(expect.arrayContaining(toolKinds))
  })
})
