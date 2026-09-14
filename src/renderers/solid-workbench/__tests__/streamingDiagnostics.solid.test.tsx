// @vitest-environment jsdom
/**
 * P89 / 施工书 S0：行几何读数与验收桥读数往返（Solid 触达部分）。
 *
 * 为什么是 `.solid.test.tsx`：本文件内含真实消息行的 DOM 夹具（class 结构），
 * 按 `check-solid-workbench-boundaries` 的规则属于 Solid 触达文件。
 *
 * 锁定：结构读得到且字段是有限数（jsdom 无布局，真实几何由真浏览器 CDP 探针取）、
 * 读数经注册表登记 → 拉取 → 注销的往返，以及边界解码失败被收敛成 failed。
 */
import { describe, expect, it } from 'vitest'
import { createStreamingDisplayScheduler } from '../streamingDisplayScheduler.ts'
import {
  STREAMING_DISPLAY_DIAGNOSTICS_KEY,
  createStreamingDisplayPublishCostRecorder,
  diagnoseStreamingRows,
  registerStreamingDisplayDiagnostics,
} from '../streamingDiagnostics.ts'
import { noteStreamingRowSet, resetStreamingRowCounters, streamingRowCounters } from '../chat/streamingRowCounters.ts'
import {
  listRendererDiagnosticsKeys,
  readRendererDiagnostics,
  registerRendererDiagnostics,
} from '../../../plugin-runtime/renderers/rendererDiagnosticsRegistry.ts'

describe('streaming display diagnostics readout (P89/S0)', () => {
  it('reads row geometry and round-trips through the acceptance readout registry', () => {
    const host = document.createElement('div')
    host.innerHTML = `
      <div class="plain-message-list">
        <div class="plain-message-list__row" data-message-id="m1" data-message-role="assistant">
          <div class="term-row term-row-assistant">
            <div class="term-assistant has-dot">
              <span class="term-assistant-dot">◆</span>
              <div class="term-assistant-body"><p>hello world</p></div>
            </div>
          </div>
        </div>
        <div class="plain-message-list__row" data-message-id="m2" data-message-role="reasoning">
          <div class="term-row term-row-reasoning">
            <div class="term-reasoning">
              <div class="term-collapse" data-open="true">
                <div class="term-collapse-content"><div class="term-reasoning-body"><p>thinking</p><p>de</p></div></div>
              </div>
            </div>
          </div>
        </div>
      </div>`

    const rows = diagnoseStreamingRows(host)
    expect(rows.map(row => [row.messageId, row.role])).toEqual([['m1', 'assistant'], ['m2', 'reasoning']])
    for (const row of rows) {
      expect(Number.isFinite(row.rowWidth)).toBe(true)
      expect(Number.isFinite(row.bodyWidth)).toBe(true)
      expect(Number.isFinite(row.markerWidth)).toBe(true)
      expect(Number.isFinite(row.textLines)).toBe(true)
    }
    // 行集合规模读数（issue #55 判据）：顶层块数与其中的小块数（< 6 字）。
    expect(rows[0]).toMatchObject({ blocks: 1, tinyRows: 0 })
    expect(rows[1]).toMatchObject({ blocks: 2, tinyRows: 1 })

    // 只读计数：rows / textParagraphs > 1 即行集合出现文本之外的边界；resets 记非后继输入。
    resetStreamingRowCounters()
    noteStreamingRowSet({ rows: 3, paragraphs: 3, reset: false })
    noteStreamingRowSet({ rows: 4, paragraphs: 2, reset: true })
    expect(streamingRowCounters()).toEqual({
      publications: 2,
      resets: 1,
      rows: 4,
      textParagraphs: 2,
      rowsPerTextLength: 2,
      maxRowsPerTextLength: 2,
    })

    const scheduler = createStreamingDisplayScheduler(() => {}, { now: () => 0 })
    const publishCost = createStreamingDisplayPublishCostRecorder()
    publishCost.record(4)
    publishCost.record(8)
    const unregister = registerStreamingDisplayDiagnostics({ host, scheduler, publishCost })
    expect(listRendererDiagnosticsKeys()).toContain(STREAMING_DISPLAY_DIAGNOSTICS_KEY)

    const result = readRendererDiagnostics(STREAMING_DISPLAY_DIAGNOSTICS_KEY)
    expect(result).toMatchObject({
      status: 'ok',
      key: STREAMING_DISPLAY_DIAGNOSTICS_KEY,
      value: {
        snapshot: { publishes: 0, lastPublicationKind: 'whole' },
        publishCost: { samples: 2, lastMs: 8, maxMs: 8, p95Ms: 8 },
        rowSet: {
          publications: 2,
          resets: 1,
          rows: 4,
          textParagraphs: 2,
          rowsPerTextLength: 2,
          maxRowsPerTextLength: 2,
        },
        rows: [
          { messageId: 'm1', role: 'assistant', blocks: 1, tinyRows: 0 },
          { messageId: 'm2', role: 'reasoning', blocks: 2, tinyRows: 1 },
        ],
      },
    })

    unregister()
    expect(readRendererDiagnostics(STREAMING_DISPLAY_DIAGNOSTICS_KEY)).toEqual({
      status: 'missing',
      key: STREAMING_DISPLAY_DIAGNOSTICS_KEY,
    })

    // 边界解码：非 JSON 载荷与抛错的 reader 都必须被收敛成 failed，不得外抛。
    const unregisterBad = registerRendererDiagnostics('p89-bad-payload', () => 'not json')
    expect(readRendererDiagnostics('p89-bad-payload')).toMatchObject({ status: 'failed' })
    unregisterBad()
    const unregisterThrow = registerRendererDiagnostics('p89-throwing', () => { throw new Error('boom') })
    expect(readRendererDiagnostics('p89-throwing')).toMatchObject({ status: 'failed', message: 'boom' })
    unregisterThrow()
    expect(readRendererDiagnostics('p89-throwing')).toEqual({ status: 'missing', key: 'p89-throwing' })

    scheduler.dispose()
  })
})
