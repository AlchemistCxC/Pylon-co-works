import { describe, expect, it } from 'vitest'
import { normalizeContentBlock } from '../normalizerSupport.ts'

describe('structured content normalization', () => {
  it.each([
    ['location', { path: '/workspace/app.ts', line: 4 }],
    ['progress', { current: 2, total: 3, message: 'working' }],
    ['list', { title: 'items', items: ['one', 'two'] }],
    ['key-value', { entries: { retries: 2 } }],
    ['json', { value: { ok: true } }],
    ['tool-use', { name: 'Read', input: { path: '/workspace/app.ts' } }],
    ['tool-result', { name: 'Read', status: 'completed', parts: [] }],
  ] as const)('keeps %s on the typed main chain', (kind, fields) => {
    const normalized = normalizeContentBlock({ type: kind, ...fields })

    expect(normalized.diagnostic).toBeUndefined()
    expect(normalized.part).toEqual({ kind, ...fields })
  })

  it('accepts underscore and content-prefixed carrier aliases without leaking the carrier field', () => {
    expect(normalizeContentBlock({ type: 'key_value', entries: { ok: true } }).part)
      .toEqual({ kind: 'key-value', entries: { ok: true } })
    expect(normalizeContentBlock({ kind: 'content.progress', current: 1, total: 2 }).part)
      .toEqual({ kind: 'progress', current: 1, total: 2 })
  })

  it('recursively normalizes rich list and tool-result parts', () => {
    expect(normalizeContentBlock({
      type: 'list',
      items: [
        { type: 'text', text: 'hello' },
        { type: 'code', text: 'const ok = true', language: 'ts' },
        { score: 0.98 },
      ],
    }).part).toEqual({
      kind: 'list',
      items: [
        { kind: 'text', text: 'hello' },
        { kind: 'code', text: 'const ok = true', language: 'ts' },
        { score: 0.98 },
      ],
    })

    expect(normalizeContentBlock({
      type: 'tool_result', status: 'completed',
      content: [{ type: 'text', text: 'done' }, { type: 'location', path: '/workspace/a.ts', line: 7 }],
    }).part).toEqual({
      kind: 'tool-result', status: 'completed',
      content: [{ kind: 'text', text: 'done' }, { kind: 'location', path: '/workspace/a.ts', line: 7 }],
    })
  })

  it('redacts sensitive structured fields before they can reach a rich inspector', () => {
    const normalized = normalizeContentBlock({
      type: 'tool-use', name: 'Fetch', input: { url: 'https://example.test', apiKey: 'secret-value' },
    })

    expect(JSON.stringify(normalized.part)).not.toContain('secret-value')
    expect(normalized.part).toEqual({
      kind: 'tool-use', name: 'Fetch', input: { url: 'https://example.test', apiKey: '[REDACTED]' },
    })
  })

  it('bounds oversized structured envelopes instead of publishing an unbounded DOM tree', () => {
    const normalized = normalizeContentBlock({ type: 'json', value: { huge: 'x'.repeat(40_000) } })

    expect(normalized.part.kind).toBe('unknown')
    expect(normalized.diagnostic?.code).toBe('content.structured.too-large')
  })
})
