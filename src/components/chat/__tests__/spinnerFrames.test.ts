// 迁移自 scripts/test-spinner-frames.mts（P91 A1）。
// 按点名清单 A.14 处置只迁纯函数断言：空串回退默认帧集、grapheme 切分（含 emoji
// ZWJ/旗标）、帧集解析去重、marker 解析、frameAt 帧定位。原脚本对 ChatView.css /
// store.ts / themeFieldDefs.ts 的源码文案断言按处置删除（自锁魔数/文案，不属于
// spinnerFrames 行为契约）。
import { describe, expect, it } from 'vitest'
import { frameAt, resolveSpinnerFrames, resolveSpinnerMarker, splitSpinnerFrames } from '../spinnerFrames.ts'

describe('spinnerFrames 纯函数（原 test-spinner-frames.mts）', () => {
  const fallback = splitSpinnerFrames('')

  it('空串回退非空默认帧集；显式帧串按帧切分', () => {
    expect(fallback.length > 0).toBe(true)
    expect(splitSpinnerFrames('◴◷◶◵')).toEqual(['◴', '◷', '◶', '◵'])
  })

  it('resolveSpinnerFrames：内置 ascii-line、custom 去重、custom 空串回退', () => {
    expect(resolveSpinnerFrames('ascii-line', '')).toEqual(['|', '/', '-', '\\'])
    expect(resolveSpinnerFrames('custom', 'aabb')).toEqual(['a', 'b'])
    expect(resolveSpinnerFrames('custom', '')).toEqual(fallback)
  })

  it('splitSpinnerFrames 按 grapheme 切分（emoji / ZWJ 序列 / 旗标不去碎）', () => {
    expect(splitSpinnerFrames('😀👨‍💻🇨🇳')).toEqual(['😀', '👨‍💻', '🇨🇳'])
    expect(splitSpinnerFrames('a👨‍💻a')).toEqual(['a', '👨‍💻'])
  })

  it('resolveSpinnerMarker：frame 模式非法值回退首帧；custom 模式空值回退首帧', () => {
    expect(resolveSpinnerMarker(['◴', '◷'], 'frame', '◷')).toBe('◷')
    expect(resolveSpinnerMarker(['◴', '◷'], 'frame', 'missing')).toBe('◴')
    expect(resolveSpinnerMarker(['◴', '◷'], 'custom', '✓')).toBe('✓')
    expect(resolveSpinnerMarker(['◴', '◷'], 'custom', '')).toBe('◴')
  })

  it('frameAt 按帧定位循环；空帧集回退默认帧集', () => {
    expect(frameAt(['a', 'b', 'c'], 0)).toBe('a')
    expect(frameAt(['a', 'b', 'c'], 120)).toBe('b')
    expect(frameAt(['a', 'b', 'c'], 360)).toBe('a')
    expect(frameAt(['←', '↑', '→'], 240)).toBe('→')
    expect(frameAt([], 1000)).toBe(fallback[Math.floor(1000 / 120) % fallback.length])
  })
})
