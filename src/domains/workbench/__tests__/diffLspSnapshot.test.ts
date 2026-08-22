import { describe, expect, it } from 'vitest'
import { diffSnapshotFromPart } from '../diffSnapshot.ts'
import { normalizeContentBlock } from '../normalizers/normalizerSupport.ts'

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
      truncation: { originalBytes: 999999 },
    })
    expect(snapshot?.binary).toBe(true)
    expect(snapshot?.truncated).toBe(true)
    expect(snapshot?.truncation).toEqual({ originalBytes: 999999 })
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
})
