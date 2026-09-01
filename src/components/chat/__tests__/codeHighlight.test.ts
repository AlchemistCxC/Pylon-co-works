// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { highlightCodeBuiltin, scopeForLanguage } from '../codeHighlight.ts'

describe('code highlight builtin', () => {
  it('resolves common file languages to grammars', () => {
    expect(scopeForLanguage('typescript')).toBe('source.ts')
    expect(scopeForLanguage('rust')).toBe('source.rust')
  })

  it('returns syntax markup for a TypeScript source', async () => {
    const html = await highlightCodeBuiltin('typescript', 'const answer: number = 42')
    expect(html).toContain('const')
    expect(html).toMatch(/class="pl-[^"]+"/)
  })
})
