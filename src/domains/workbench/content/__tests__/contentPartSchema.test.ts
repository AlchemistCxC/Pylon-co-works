import { describe, expect, it } from 'vitest'
import {
  coalesceAdjacentDisplayTextParts,
  coalesceAdjacentReasoningParts,
  createUnknownContentPart,
  parseContentPart,
  type ContentPart,
} from '../contentPartSchema.ts'

describe('ContentPart schema', () => {
  it('coalesces only adjacent display text and preserves rich-content boundaries', () => {
    const code = { kind: 'code', text: 'const answer = 42', language: 'ts' } as const
    const parts = coalesceAdjacentDisplayTextParts([
      { kind: 'text', text: '连续' },
      { kind: 'markdown', text: '正文' },
      code,
      { kind: 'markdown', text: '尾部' },
      { kind: 'text', text: '正文' },
    ])

    expect(parts).toEqual([
      { kind: 'markdown', text: '连续正文' },
      code,
      { kind: 'markdown', text: '尾部正文' },
    ])
    expect(parts[1]).toBe(code)
  })

  it('coalesces reasoning text kinds without crossing rich-content boundaries', () => {
    const code = { kind: 'code', text: 'const answer = 42', language: 'ts' } as const
    const parts = coalesceAdjacentReasoningParts([
      { kind: 'text', text: '先' },
      { kind: 'reasoning', text: '思考' },
      { kind: 'thinking', text: '再' },
      code,
      { kind: 'markdown', text: '后' },
      { kind: 'text', text: '续' },
    ])

    expect(parts).toEqual([
      { kind: 'reasoning', text: '先思考再' },
      code,
      { kind: 'markdown', text: '后续' },
    ])
    expect(parts[1]).toBe(code)
  })

  it('accepts only normalized terminal streams and lifecycle metadata', () => {
    expect(parseContentPart({
      kind: 'terminal',
      command: 'npm test',
      processId: 'proc-1',
      sessionId: 'shell-1',
      streams: [{ stream: 'stdout', text: 'ok', ordinal: 0 }],
      status: 'completed',
      exitCode: 0,
      truncation: { capturedLines: 1, omittedLines: 2, capturedBytes: 2, omittedBytes: 4 },
    }).ok).toBe(true)

    expect(parseContentPart({ kind: 'terminal', streams: [{ stream: 'stdin', text: 'secret' }] }).ok).toBe(false)
    expect(parseContentPart({ kind: 'terminal', streams: [{ stream: 'stdout' }] }).ok).toBe(false)
    expect(parseContentPart({ kind: 'terminal', streams: [{ stream: 'stdout', text: 'x', ordinal: -1 }] }).ok).toBe(false)
    expect(parseContentPart({ kind: 'terminal', streams: [], terminatedBy: 'provider-magic' }).ok).toBe(false)
  })

  it('accepts only normalized structured log entries', () => {
    expect(parseContentPart({
      kind: 'log', source: 'worker', processId: 'proc-1',
      entries: [{ level: 'warn', text: 'slow', ordinal: 2, timestampConfidence: 'synthetic' }],
    }).ok).toBe(true)
    expect(parseContentPart({ kind: 'log', entries: [] }).ok).toBe(false)
    expect(parseContentPart({ kind: 'log', entries: [{ level: 'verbose', text: 'x' }] }).ok).toBe(false)
    expect(parseContentPart({ kind: 'log', entries: [{ level: 'info', text: 42 }] }).ok).toBe(false)
    expect(parseContentPart({ kind: 'log', entries: [{ level: 'info', text: 'x', timestampConfidence: 'guessed' }] }).ok).toBe(false)
  })

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

  it('validates the canonical C03 media source and metadata boundary', () => {
    expect(parseContentPart({
      kind: 'image', source: 'iVBORw0KGgo=', sourceKind: 'base64', mimeType: 'image/png',
      width: 640, height: 480, caption: '架构图',
    }).ok).toBe(true)
    expect(parseContentPart({
      kind: 'video', source: 'C:\\media\\demo.mp4', sourceKind: 'path', mimeType: 'video/mp4',
      durationMs: 1_500,
    }).ok).toBe(true)

    expect(parseContentPart({ kind: 'image', source: '   ' }).ok).toBe(false)
    expect(parseContentPart({ kind: 'image', source: 'https://safe.test/a.png', sourceKind: 'guess' }).ok).toBe(false)
    expect(parseContentPart({ kind: 'image', source: 'https://safe.test/a.png', width: -1 }).ok).toBe(false)
    expect(parseContentPart({ kind: 'image', source: 'https://safe.test/a.png', height: Number.NaN }).ok).toBe(false)
    expect(parseContentPart({ kind: 'audio', source: 'https://safe.test/a.png', mimeType: 'image/png' }).ok).toBe(false)
    expect(parseContentPart({
      kind: 'image', source: 'https://safe.test/a.png', headers: { authorization: 'Bearer secret' },
    }).ok).toBe(false)
    expect(parseContentPart({
      kind: 'image', source: 'https://safe.test/a.png', base64: 'duplicate-payload',
    }).ok).toBe(false)
  })

  it('round-trips unknown raw without turning it into invalid JSON', () => {
    const unknown: ContentPart = createUnknownContentPart('provider.unknown', { nested: [1, true, null] })
    const parsed = parseContentPart(JSON.parse(JSON.stringify(unknown)))
    expect(parsed).toEqual({ ok: true, value: unknown })
  })
})
