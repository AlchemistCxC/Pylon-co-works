let graphemeSegmenter: Intl.Segmenter | null = null

export function getGraphemeSegmenter(): Intl.Segmenter {
  if (!graphemeSegmenter) {
    graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  }
  return graphemeSegmenter
}

// 东亚全角/宽字符区间（Unicode East Asian Width W/F 主流集合，参考 CC utils/truncate.ts 的宽度语义）
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x2600, 0x27ff], // 杂项符号/装饰符号（✅⚠️✈️ 等常用 emoji）
  [0x1f000, 0x1faff], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]

function isWide(codePoint: number): boolean {
  for (const [start, end] of WIDE_RANGES) {
    if (codePoint >= start && codePoint <= end) return true
  }
  return false
}

function isZeroWidth(codePoint: number): boolean {
  return codePoint < 0x20
    || (codePoint >= 0x200b && codePoint <= 0x200f)   // ZWSP/ZWJ/ZWNJ 等格式字符
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)   // variation selectors
    || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) // emoji 肤色修饰
}

/** 单个 grapheme 的显示宽度（0/1/2），按码点聚合；emoji 序列按宽 2 计 */
export function graphemeWidth(segment: string): number {
  if (!segment) return 0
  if (segment.length > 1 && segment.includes('\u200d')) return 2 // ZWJ 组合（家庭/职业 emoji 等）
  let width = 0
  for (const char of segment) {
    const codePoint = char.codePointAt(0)!
    if (isZeroWidth(codePoint)) continue
    width += isWide(codePoint) ? 2 : 1
  }
  return Math.min(2, Math.max(0, width))
}

/** 字符串显示宽度（grapheme 安全，不拆 emoji/CJK 组合） */
export function stringWidth(text: string): number {
  if (!text) return 0
  let width = 0
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    width += graphemeWidth(segment)
  }
  return width
}

/** 按显示宽度截断（grapheme 边界），追加 … */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth <= 1) return '…'
  let width = 0
  let result = ''
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const segWidth = graphemeWidth(segment)
    if (width + segWidth > maxWidth - 1) break
    result += segment
    width += segWidth
  }
  return `${result}…`
}

/** 保留尾部截断（前缀 …），grapheme 安全 */
export function truncateStartToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth <= 1) return '…'
  const segments = [...getGraphemeSegmenter().segment(text)]
  let width = 0
  let startIndex = segments.length
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segWidth = graphemeWidth(segments[index]!.segment)
    if (width + segWidth > maxWidth - 1) break
    width += segWidth
    startIndex = index
  }
  return `…${segments.slice(startIndex).map(part => part.segment).join('')}`
}
