import { describe, expect, it } from 'vitest'
import { resolveRendererMountProps } from '../messageRenderer.ts'
import { graphemeWidth, segmentGraphemes, stringWidth, truncateToWidth } from '../../utils/textWidth.ts'
import { stripHiddenUnicode } from '../../utils/unicodeSanitizer.ts'

describe('contracts and utility behavior', () => {
  it('accepts valid renderer mount payload and rejects malformed input', () => {
    const component = () => null
    expect(resolveRendererMountProps({ component, componentProps: { id: 1 } })).toEqual({ component, componentProps: { id: 1 } })
    expect(() => resolveRendererMountProps({ component: null })).toThrow('RenderSurface.mount')
  })

  it('keeps grapheme boundaries and display width for CJK/emoji', () => {
    expect(segmentGraphemes('A👩‍💻中')).toEqual(['A', '👩‍💻', '中'])
    expect(graphemeWidth('👩‍💻')).toBe(2)
    expect(stringWidth('A中')).toBe(3)
    expect(truncateToWidth('A中B', 3)).toBe('A…')
  })

  it('strips hidden unicode controls without changing visible text', () => {
    expect(stripHiddenUnicode('safe\u200Btext\u202E')).toBe('safetext')
    expect(stripHiddenUnicode('正常')).toBe('正常')
  })
})

// Type-only contracts are checked by the TypeScript build through concrete fixtures.
