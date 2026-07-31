const HIDDEN_UNICODE_PATTERN = /[\p{Cf}\p{Co}\p{Cn}]/gu

/**
 * 剥离隐藏 Unicode 控制/私用/未分配字符（零宽字符、bidi 覆盖、私用区等）。
 * 降级方案：不做 NFKC 归一化（不改写正常输入语义），只清除会注入/欺骗显示的字符。
 * 参考 CC utils/sanitization.ts 的 partiallySanitizeUnicode 危险范围剥离部分。
 */
export function stripHiddenUnicode(text: string): string {
  return text.replace(HIDDEN_UNICODE_PATTERN, '')
}

export function recursivelyStripHiddenUnicode(value: unknown): unknown {
  if (typeof value === 'string') return stripHiddenUnicode(value)
  if (Array.isArray(value)) return value.map(item => recursivelyStripHiddenUnicode(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, recursivelyStripHiddenUnicode(item)]),
    )
  }
  return value
}
