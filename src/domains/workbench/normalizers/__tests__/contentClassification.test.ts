import { describe, expect, it } from 'vitest'
import { normalizeContentBlock } from '../normalizerSupport.ts'

/**
 * C02 RED：normalizer 区分 reference / selection / inline document / external resource。
 *
 * 卡面要求：
 * - reference（路径引用）、selection（带行/列范围的选择区）、inline document、external resource 四类可辨；
 * - Windows/URI 路径不做字符串猜测互转（path 保持原样，uri 只经 uri 字段）；
 * - base64 blob 不直接进 DOM——保留 metadata，blob 不进 text。
 */

describe('C02 normalizer content classification', () => {
  it('classifies path-only blocks as file-reference preserving raw path form', () => {
    const { part } = normalizeContentBlock({
      type: 'file_reference',
      path: 'C:\\Users\\demo\\report.md',
      displayName: 'report.md',
    })
    expect(part.kind).toBe('file-reference')
    const filePart = part as { kind: string; path: string; displayName?: string }
    // Windows 路径保持原样——不做 file:/// 猜测互转
    expect(filePart.path).toBe('C:\\Users\\demo\\report.md')
    expect(filePart.displayName).toBe('report.md')
  })

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])('rejects invalid file sizes instead of publishing non-JSON metadata: %s', size => {
    const normalized = normalizeContentBlock({ type: 'file_reference', path: '/workspace/a.bin', size })
    expect(normalized.part.kind).toBe('unknown')
    expect(normalized.diagnostic?.code).toBe('content.file-reference.invalid')
  })

  it('classifies selection blocks with line/column range as file-selection', () => {
    const { part } = normalizeContentBlock({
      type: 'file_selection',
      path: '/workspace/src/main.ts',
      selection: { start: { line: 10, column: 4 }, end: { line: 24, column: 0 } },
      language: 'ts',
    })
    expect(part.kind).toBe('file-selection')
    const sel = part as { kind: string; path: string; selection?: { start?: { line?: number }; end?: { line?: number } }; language?: string }
    expect(sel.path).toBe('/workspace/src/main.ts')
    expect(sel.selection?.start?.line).toBe(10)
    expect(sel.selection?.end?.line).toBe(24)
    expect(sel.language).toBe('ts')
  })

  it('selection without path falls back to unknown, not guessed file-reference', () => {
    const { part } = normalizeContentBlock({ type: 'file_selection', language: 'ts' })
    // 无 path 无法定位文件——进 unknown fallback 而非猜
    expect(part.kind).toBe('unknown')
  })

  it.each([
    { selection: {} },
    { selection: { start: { line: -1 } } },
    { selection: { start: { line: 24 }, end: { line: 10 } } },
  ])('rejects invalid selection boundaries instead of publishing an empty range: $selection', input => {
    const normalized = normalizeContentBlock({ type: 'file_selection', path: '/workspace/a.ts', ...input })
    expect(normalized.part.kind).toBe('unknown')
    expect(normalized.diagnostic?.code).toBe('content.file-selection.invalid')
  })

  it('keeps embedded resource metadata without promoting base64 into displayable text', () => {
    const { part } = normalizeContentBlock({
      type: 'resource',
      resource: {
        uri: 'file:///docs/spec.pdf',
        mimeType: 'application/pdf',
        blob: 'JVBERi0xLjQK',
      },
    })
    expect(part.kind).toBe('resource')
    const res = part as { kind: string; uri: string; mimeType?: string; text?: string; hasBlob: boolean }
    expect(res.uri).toBe('file:///docs/spec.pdf')
    expect(res.mimeType).toBe('application/pdf')
    // blob 不进入 text 字段（渲染层只显示安全 metadata + 下载）
    expect(res.text).toBeUndefined()
    expect(res.hasBlob).toBe(true)
  })

  it('keeps external resource links with provider title', () => {
    const { part } = normalizeContentBlock({
      type: 'resource_link',
      uri: 'https://example.com/guide',
      name: '使用指南',
    })
    expect(part.kind).toBe('resource')
    const res = part as { kind: string; uri: string; title?: string }
    expect(res.uri).toBe('https://example.com/guide')
    expect(res.title).toBe('使用指南')
  })

  it.each([
    { type: 'resource_link', uri: '   ' },
    { type: 'resource', resource: { uri: '' } },
  ])('routes blank resource locations to unknown with diagnostics', input => {
    const normalized = normalizeContentBlock(input)
    expect(normalized.part.kind).toBe('unknown')
    expect(normalized.diagnostic?.code).toBe('content.resource.invalid')
  })

  it('does not promote a SOURCE-ONLY document attachment without a recognized wire carrier', () => {
    const normalized = normalizeContentBlock({
      type: 'document', title: 'provider-only.pdf', path: '/provider/private.pdf',
    })
    expect(normalized.part.kind).toBe('unknown')
  })
})
