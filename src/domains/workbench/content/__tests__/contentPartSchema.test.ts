import { describe, expect, it } from 'vitest'
import {
  createUnknownContentPart,
  parseContentPart,
  type ContentPart,
} from '../contentPartSchema.ts'

describe('ContentPart schema', () => {
  it.each([
    { kind: 'text', text: 'hello' },
    { kind: 'thinking', text: 'private reasoning' },
    { kind: 'image', source: 'https://example.test/image.png', mimeType: 'image/png' },
    { kind: 'resource', uri: 'mcp://resource/1', title: 'Resource' },
    { kind: 'diff', path: 'src/app.ts', unified: '@@ -1 +1 @@' },
    { kind: 'location', path: 'src/app.ts', line: 3, column: 4 },
    { kind: 'tool-result', status: 'completed', parts: [] },
  ] satisfies readonly Record<string, unknown>[])('accepts $kind content', value => {
    const parsed = parseContentPart(value)
    expect(parsed.ok).toBe(true)
  })

  it('keeps an unknown block visible with raw, summary and truncation metadata', () => {
    const raw = { providerType: 'future.block', payload: 'x'.repeat(20_000) }
    const unknown = createUnknownContentPart('future.block', raw, { maxRawBytes: 256 })
    expect(unknown.kind).toBe('unknown')
    expect(unknown.originalType).toBe('future.block')
    expect(unknown.summary).toContain('future.block')
    expect(unknown.truncation?.truncated).toBe(true)
    expect(unknown.truncation?.omittedBytes).toBeGreaterThan(0)
    expect(JSON.stringify(unknown.raw).length).toBeLessThan(2_000)
    expect(parseContentPart(unknown)).toEqual({ ok: true, value: unknown })
  })

  it('rejects malformed JSON shapes with path/code diagnostics', () => {
    const result = parseContentPart({ kind: 'image', source: 42 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]).toMatchObject({ path: ['source'], code: 'type.string' })
    expect(result.issues[0].received).toBe('number')
  })

  it('accepts safe C02 document metadata but rejects inline blob payloads', () => {
    expect(parseContentPart({
      kind: 'document', title: 'spec.pdf', uri: 'file:///spec.pdf',
      mimeType: 'application/pdf', hasBlob: true,
    }).ok).toBe(true)
    expect(parseContentPart({ kind: 'document', title: 'empty', text: '' }).ok).toBe(false)
    expect(parseContentPart({ kind: 'resource', uri: '   ' }).ok).toBe(false)

    for (const value of [
      { kind: 'document', title: 'private.pdf', blob: 'JVBERi0xLjQK' },
      { kind: 'resource', uri: 'file:///private.pdf', blob: 'JVBERi0xLjQK' },
    ]) {
      const parsed = parseContentPart(value)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['blob'], code: 'content.binary-inline' }),
      ]))
    }
  })

  it('round-trips unknown raw without turning it into invalid JSON', () => {
    const unknown: ContentPart = createUnknownContentPart('provider.unknown', { nested: [1, true, null] })
    const parsed = parseContentPart(JSON.parse(JSON.stringify(unknown)))
    expect(parsed).toEqual({ ok: true, value: unknown })
  })
})
