/**
 * safeJson — JSON.stringify 防炸封装。
 *
 * #228 批次D 收敛 components/ErrorCenter.tsx 与 chat/ToolInvocationCard.solid.tsx
 * 的两份 safeJson 副本；两处的差异（回退文案、是否截断）经 options 显式表达，
 * 各调用点行为不变。序列化抛错（循环引用/BigInt）与结果非字符串（顶层
 * undefined/function 等 stringify 返回 undefined 的形态）一律落 fallback。
 */
export interface SafeJsonOptions {
  /** 序列化抛错或结果非字符串时的回退文案。 */
  fallback: string
  /** 超长截断阈值（字符数）；缺省不截断。 */
  maxChars?: number
  /** 截断后追加在尾部的提示文案（仅 maxChars 生效时出现）。 */
  truncationSuffix?: string
}

export function safeJson(value: unknown, options: SafeJsonOptions): string {
  const { fallback, maxChars, truncationSuffix } = options
  try {
    const serialized = JSON.stringify(value, null, 2)
    if (typeof serialized !== 'string') return fallback
    if (maxChars !== undefined && serialized.length > maxChars) {
      return `${serialized.slice(0, maxChars)}${truncationSuffix ?? ''}`
    }
    return serialized
  } catch { return fallback }
}
