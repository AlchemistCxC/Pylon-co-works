import { describe, expect, it } from 'vitest'
import { normalizeContentBlock } from '../normalizerSupport.ts'

/**
 * C05 RED：search-result / link ContentPart 归一化契约（DIC-C05-01）。
 *
 * 卡面要求：
 * - search result 每条保留 source、rank、location、snippet、score、paging token；
 * - 高亮按纯文本 range，不注入 HTML；
 * - URL 显示 host/title/status，危险/非法 scheme 禁用动作；
 * - 动态 MCP 缺 schema 时退化 generic，不建立 provider 分支。
 */

describe('C05 normalizer search-result classification', () => {
  it('normalizes search_result block preserving entries with rank/snippet/highlight ranges', () => {
    const { part } = normalizeContentBlock({
      type: 'search_result',
      query: 'render lifecycle',
      total: 42,
      pagingToken: 'page-2',
      results: [
        {
          source: '/src/app.tsx',
          rank: 1,
          location: { line: 12 },
          snippet: 'the render lifecycle starts here',
          highlights: [{ start: 4, end: 10 }],
          score: 0.93,
        },
        {
          source: 'https://docs.example.com/lifecycle',
          rank: 2,
          title: 'Lifecycle docs',
          snippet: 'lifecycle overview',
        },
      ],
    })
    expect(part.kind).toBe('search-result')
    const sr = part as unknown as {
      query?: string; total?: number; pagingToken?: string
      results?: readonly { source?: string; rank?: number; location?: unknown; snippet?: string; highlights?: unknown; score?: number }[]
    }
    expect(sr.query).toBe('render lifecycle')
    expect(sr.total).toBe(42)
    expect(sr.pagingToken).toBe('page-2')
    expect(sr.results).toHaveLength(2)
    expect(sr.results?.[0]?.source).toBe('/src/app.tsx')
    expect(sr.results?.[0]?.rank).toBe(1)
    expect(sr.results?.[0]?.highlights).toEqual([{ start: 4, end: 10 }])
    expect(sr.results?.[0]?.score).toBe(0.93)
    expect(sr.results?.[1]?.source).toBe('https://docs.example.com/lifecycle')
  })

  it('falls back to unknown when search_result has no usable entries', () => {
    const { part } = normalizeContentBlock({ type: 'search_result' })
    expect(part.kind).toBe('unknown')
  })

  it('narrows every result entry and drops malformed/provider-private fields', () => {
    const normalized = normalizeContentBlock({
      type: 'search_result', query: 'safe', total: -4, pagingToken: '  next  ',
      results: [
        { source: ' /src/a.ts ', rank: 1, location: { path: '/src/a.ts', line: 4, privateOffset: 99 }, snippet: 'abcd', highlights: [{ start: 0, end: 2 }, { start: -1, end: 9 }], score: 0.8, providerSecret: 'drop-me' },
        { source: '', snippet: 'malformed' },
        null,
      ],
    })
    expect(normalized.part).toEqual({
      kind: 'search-result', query: 'safe', pagingToken: 'next',
      results: [{
        source: '/src/a.ts', rank: 1, location: { path: '/src/a.ts', line: 4 },
        snippet: 'abcd', highlights: [{ start: 0, end: 2 }], score: 0.8,
      }],
    })
    expect(normalized.diagnostic?.code).toBe('content.search-result.entries-dropped')
    expect(JSON.stringify(normalized.part)).not.toContain('drop-me')
    expect(JSON.stringify(normalized.part)).not.toContain('privateOffset')
  })

  it('falls back to unknown when every search result entry is malformed', () => {
    const { part, diagnostic } = normalizeContentBlock({ type: 'search_result', results: [null, {}, { source: '  ' }] })
    expect(part.kind).toBe('unknown')
    expect(diagnostic?.code).toBe('content.search-result.empty')
  })

  it('does not interpret highlight ranges as HTML — they stay numeric ranges', () => {
    const { part } = normalizeContentBlock({
      type: 'search_result',
      results: [{ source: 'a.md', snippet: '<b>bold</b> claim', highlights: [{ start: 0, end: 3 }] }],
    })
    const sr = part as unknown as { results?: readonly { snippet?: string; highlights?: unknown }[] }
    // snippet 原样保留（含尖括号），高亮是数字 range 而非 HTML 注入
    expect(sr.results?.[0]?.snippet).toBe('<b>bold</b> claim')
    expect(sr.results?.[0]?.highlights).toEqual([{ start: 0, end: 3 }])
  })

  it('classifies link blocks with url/title and keeps raw form', () => {
    const { part } = normalizeContentBlock({
      type: 'link',
      url: 'https://example.com/guide',
      title: '使用指南',
    })
    expect(part.kind).toBe('link')
    const link = part as unknown as { url?: string; title?: string }
    expect(link.url).toBe('https://example.com/guide')
    expect(link.title).toBe('使用指南')
  })

  it('link without url falls back to unknown', () => {
    const { part } = normalizeContentBlock({ type: 'link', title: 'no target' })
    expect(part.kind).toBe('unknown')
  })

  it('trims links and drops provider-private fields at the canonical boundary', () => {
    const { part } = normalizeContentBlock({ type: 'link', url: '  https://example.com/a  ', title: '  Guide  ', status: 200, secret: 'drop' })
    expect(part).toEqual({ kind: 'link', url: 'https://example.com/a', title: 'Guide', status: 200 })
  })
})
