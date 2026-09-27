import { describe, expect, it } from 'vitest'
import { visibleDiagnostics } from '../solidWorkbenchProjectionSupport.ts'

/**
 * #324：对话面诊断门控——info 级（peri.turn-done 传输层留痕等）不进对话面，
 * warning/error 照常；systemErrors 已覆盖的 eventId 不重复出卡。
 */
describe('#324 visibleDiagnostics gates info-level notices out of the conversation surface', () => {
  const document = {
    systemErrors: [],
    diagnostics: [
      { code: 'peri.turn-done', message: 'transport bookkeeping', eventId: 'e1', sequence: 1, level: 'info' },
      { code: 'wire.unknown', message: 'unrecognized update', eventId: 'e2', sequence: 2, level: 'warning' },
      { code: 'provider.error', message: '处理失败', eventId: 'e3', sequence: 3, level: 'error' },
    ],
  } as unknown as Parameters<typeof visibleDiagnostics>[0]

  it('keeps warning and error diagnostics on the surface', () => {
    const visible = visibleDiagnostics(document)
    expect(visible.map(item => item.code)).toEqual(['wire.unknown', 'provider.error'])
  })

  it('keeps info rows in document.diagnostics (data retained for diagnostics/replay)', () => {
    expect(document.diagnostics).toHaveLength(3)
  })

  it('still deduplicates entries already surfaced as system errors', () => {
    const withSystemError = {
      systemErrors: [{ eventId: 'e3' }],
      diagnostics: document.diagnostics,
    } as unknown as Parameters<typeof visibleDiagnostics>[0]
    expect(visibleDiagnostics(withSystemError).map(item => item.code)).toEqual(['wire.unknown'])
  })
})
