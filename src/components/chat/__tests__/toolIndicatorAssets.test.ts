import { describe, expect, it } from 'vitest'
import { resolveToolIndicatorAssetForTone, toolIndicatorOptions } from '../toolIndicatorAssets.ts'

describe('tool indicator assets', () => {
  it('exposes a broad, labelled glyph palette', () => {
    const options = toolIndicatorOptions()
    expect(options.length).toBeGreaterThanOrEqual(18)
    expect(options.map(option => option.value)).toEqual(expect.arrayContaining(['check', 'cross', 'star', 'hourglass']))
    expect(options.every(option => option.label.trim().length > 1)).toBe(true)
  })

  it('resolves independent run/ok/error glyphs and falls back for legacy themes', () => {
    const values = { toolIndicator: 'circle', toolIndicatorRun: 'play', toolIndicatorOk: 'check', toolIndicatorErr: 'cross' }
    expect(resolveToolIndicatorAssetForTone('run', values).glyph).toBe('▶')
    expect(resolveToolIndicatorAssetForTone('ok', values).glyph).toBe('✓')
    expect(resolveToolIndicatorAssetForTone('err', values).glyph).toBe('×')
    expect(resolveToolIndicatorAssetForTone('ok', { toolIndicator: 'diamond' }).glyph).toBe('◆')
  })
})
