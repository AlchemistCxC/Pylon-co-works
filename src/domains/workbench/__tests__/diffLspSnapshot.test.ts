import { describe, expect, it } from 'vitest'
import { diffSnapshotFromPart } from '../diffSnapshot.ts'
import { normalizeContentBlock } from '../normalizers/normalizerSupport.ts'
import { parseContentPart } from '../content/contentPartSchema.ts'

/**
 * C06 RED：content.diff 结构化快照 + LSP diagnostic 归一化契约。
 *
 * 卡面要求（含架构层消费补全 / DIC-C06-01）：
 * - diff snapshot 同时保留 path、range、hunks、old/new、status、truncation；
 * - LSP diagnostic 至少保留 code/level/message/path/range/source/related；
 * - related、未知 patch 字段和 provider 原文只能作为 normalized metadata/unknown part
 *   展开，renderer 不读 vendor raw 决定分支；
 * - 结构化 diff 可重建，renderer 不重新解析 provider raw patch。
 */

describe('C06 diffSnapshotFromPart', () => {
  it('narrows a structured diff part preserving path/range/hunks/stats', () => {
    const snapshot = diffSnapshotFromPart({
      kind: 'diff',
      path: '/src/app.ts',
      oldPath: '/src/old.ts',
      range: { start: { line: 9, character: 2, providerOffset: 90 }, end: { line: 14, character: 0 } },
      hunks: [
        { oldStart: 10, oldLines: 3, newStart: 10, newLines: 5 },
        { oldStart: 40, oldLines: 2, newStart: 42, newLines: 1 },
      ],
      additions: 6,
      deletions: 4,
      status: 'modified',
    })
    expect(snapshot).not.toBeNull()
    if (!snapshot) return
    expect(snapshot.path).toBe('/src/app.ts')
    expect(snapshot.oldPath).toBe('/src/old.ts')
    expect(snapshot.range).toEqual({ start: { line: 9, character: 2 }, end: { line: 14, character: 0 } })
    expect(snapshot.hunks).toHaveLength(2)
    expect(snapshot.hunks?.[0]).toEqual({ oldStart: 10, oldLines: 3, newStart: 10, newLines: 5 })
    expect(snapshot.additions).toBe(6)
    expect(snapshot.deletions).toBe(4)
    expect(snapshot.status).toBe('modified')
  })

  it('keeps unified/raw text as audit fields separate from structured hunks', () => {
    const snapshot = diffSnapshotFromPart({
      kind: 'diff',
      path: '/a.txt',
      unified: '--- a\n+++ b\n@@ -1,3 +1,5 @@',
      rawPatch: 'provider specific patch blob',
    })
    expect(snapshot?.unified).toContain('@@ -1,3 +1,5 @@')
    expect(snapshot?.rawPatch).toBe('provider specific patch blob')
    // 结构化 hunks 与审计文本并存，互不替代
    expect(snapshot?.hunks).toBeUndefined()
  })

  it('marks binary diffs and preserves truncation metadata', () => {
    const snapshot = diffSnapshotFromPart({
      kind: 'diff',
      path: '/assets/logo.png',
      binary: true,
      truncated: true,
      truncation: {
        truncated: true, originalBytes: 999999, retainedBytes: 8192,
        omittedBytes: 991807, reason: 'size-limit',
      },
    })
    expect(snapshot?.binary).toBe(true)
    expect(snapshot?.truncated).toBe(true)
    expect(snapshot?.truncation).toEqual({
      truncated: true, originalBytes: 999999, retainedBytes: 8192,
      omittedBytes: 991807, reason: 'size-limit',
    })
  })

  it('rebuildable: oldText/newText round-trips into lines without re-parsing raw', () => {
    const snapshot = diffSnapshotFromPart({
      kind: 'diff',
      path: '/b.txt',
      oldText: 'line1\nline2',
      newText: 'line1\nchanged\nline3',
    })
    expect(snapshot?.oldText).toBe('line1\nline2')
    expect(snapshot?.newText).toBe('line1\nchanged\nline3')
    // 可重建：lines 由 old/new 派生，renderer 不需要再碰 provider raw patch
    expect(snapshot?.lines).toBeDefined()
    expect(snapshot!.lines!.length).toBeGreaterThan(0)
  })

  it('returns null for non-diff parts', () => {
    expect(diffSnapshotFromPart({ kind: 'text', text: 'plain' })).toBeNull()
  })

  it('normalizes diff fields without leaking provider-private values or malformed rows', () => {
    const normalized = normalizeContentBlock({
      type: 'diff', path: ' /src/app.ts ', status: 'modified',
      lines: [
        { kind: 'removed', text: 'old' },
        { kind: 'provider-private', text: 'do not render' },
        { kind: 'added', text: 'new', providerOffset: 42 },
      ],
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, providerId: 'secret-hunk' }],
      providerSecret: 'do-not-cross-the-seam',
    })

    expect(normalized.part).toEqual({
      kind: 'diff', path: '/src/app.ts', status: 'modified',
      lines: [{ kind: 'removed', text: 'old' }, { kind: 'added', text: 'new' }],
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
      unknownFields: ['providerSecret'],
    })
    expect(normalized.diagnostic?.code).toBe('content.diff.fields-dropped')
    expect(JSON.stringify(normalized.part)).not.toContain('do-not-cross-the-seam')
    expect(JSON.stringify(normalized.part)).not.toContain('secret-hunk')
  })

  it('diagnoses invalid known diff fields instead of retaining or silently dropping them', () => {
    const normalized = normalizeContentBlock({
      type: 'diff', path: '/src/a.ts', lines: [{ kind: 'added', text: 'new' }],
      status: 42, additions: -1, binary: 'yes', truncation: { originalBytes: 10 },
    })
    expect(normalized.diagnostic?.code).toBe('content.diff.fields-dropped')
    expect(normalized.part).toEqual({ kind: 'diff', path: '/src/a.ts', lines: [{ kind: 'added', text: 'new' }] })
  })
})

describe('C06 LSP diagnostic normalization', () => {
  it('normalizes lsp_diagnostic block keeping code/severity/message/path/range/source', () => {
    const { part } = normalizeContentBlock({
      type: 'lsp_diagnostic',
      severity: 'error',
      code: 'TS2345',
      source: 'typescript',
      message: "Argument of type 'string' is not assignable",
      path: '/src/app.ts',
      range: { start: { line: 41, character: 12 }, end: { line: 41, character: 30 } },
      related: [
        { message: 'target type declared here', path: '/src/types.ts', range: { start: { line: 7, character: 0 } } },
      ],
    })
    expect(part.kind).toBe('diagnostic-lsp')
    const lsp = part as unknown as {
      severity?: string; code?: string; source?: string; message?: string
      path?: string; range?: unknown; related?: readonly unknown[]
    }
    expect(lsp.severity).toBe('error')
    expect(lsp.code).toBe('TS2345')
    expect(lsp.source).toBe('typescript')
    expect(lsp.message).toContain('not assignable')
    expect(lsp.path).toBe('/src/app.ts')
    expect(lsp.range).toEqual({ start: { line: 41, character: 12 }, end: { line: 41, character: 30 } })
    expect(lsp.related).toHaveLength(1)
  })

  it('diagnostic without required fields falls back to unknown with diagnostic entry', () => {
    const { part, diagnostic } = normalizeContentBlock({ type: 'lsp_diagnostic', severity: 'warning' })
    expect(part.kind).toBe('unknown')
    expect(diagnostic?.code).toBe('content.diagnostic-lsp.invalid')
  })

  it('narrows ranges and related locations instead of passing provider objects through', () => {
    const normalized = normalizeContentBlock({
      type: 'lsp_diagnostic', severity: 'warning', code: 6133, source: 'typescript',
      message: 'unused value', path: ' /src/a.ts ', providerDiagnosticId: 'private-id',
      range: {
        start: { line: 4, character: 2, providerOffset: 99 },
        end: { line: 4, character: 7 },
        providerRange: 'private-range',
      },
      related: [
        { message: 'declared here', path: '/src/b.ts', range: { start: { line: 1, character: 0 } }, providerId: 'private-related' },
        { message: '', path: '/src/invalid.ts' },
      ],
    })

    expect(normalized.part).toEqual({
      kind: 'diagnostic-lsp', severity: 'warning', code: '6133', source: 'typescript',
      message: 'unused value', path: '/src/a.ts',
      range: { start: { line: 4, character: 2 }, end: { line: 4, character: 7 } },
      related: [{ message: 'declared here', path: '/src/b.ts', range: { start: { line: 1, character: 0 } } }],
      unknownFields: ['providerDiagnosticId'],
    })
    expect(normalized.diagnostic?.code).toBe('content.diagnostic-lsp.fields-dropped')
    expect(JSON.stringify(normalized.part)).not.toContain('private-')
  })

  it('diagnoses invalid known optional LSP fields instead of silently discarding them', () => {
    const normalized = normalizeContentBlock({
      type: 'lsp_diagnostic', message: 'problem', path: '/src/a.ts',
      severity: 2, code: Number.NaN, source: false,
    })
    expect(normalized.part).toEqual({ kind: 'diagnostic-lsp', message: 'problem', path: '/src/a.ts' })
    expect(normalized.diagnostic?.code).toBe('content.diagnostic-lsp.fields-dropped')
  })
})

describe('C06 canonical content schema', () => {
  it('accepts normalized diff/LSP snapshots and rejects malformed nested ranges or rows', () => {
    expect(parseContentPart({
      kind: 'diff', path: '/src/a.ts',
      lines: [{ kind: 'removed', text: 'a' }, { kind: 'added', text: 'b' }],
    }).ok).toBe(true)
    expect(parseContentPart({
      kind: 'diff', path: '/src/a.ts', lines: [{ kind: 'vendor', text: 'bad' }],
    }).ok).toBe(false)
    expect(parseContentPart({
      kind: 'diagnostic-lsp', message: 'bad call', path: '/src/a.ts',
      range: { start: { line: 2, character: 3 }, end: { line: 2, character: 7 } },
    }).ok).toBe(true)
    expect(parseContentPart({
      kind: 'diagnostic-lsp', message: 'bad call', path: '/src/a.ts',
      range: { start: { line: -1 } },
    }).ok).toBe(false)
  })
})
