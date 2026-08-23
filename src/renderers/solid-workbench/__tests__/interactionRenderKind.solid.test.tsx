// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { interactionRenderKind } from '../SolidWorkbenchApp.solid.tsx'

describe('C12 interaction render kind routing', () => {
  it.each([
    ['oauth', 'interaction.oauth'],
    ['secret', 'interaction.secret'],
    ['sudo', 'interaction.sudo'],
  ])('routes %s to its formal render kind', (kind, expected) => {
    expect(interactionRenderKind({ request: { kind } } as never)).toBe(expected)
  })
})
