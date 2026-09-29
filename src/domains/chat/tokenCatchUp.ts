/**
 * tokenCatchUp — token 追赶计数（P1-08）。
 *
 * 显示值向真实值递增（step = 余量/4，至少 1），永不超过真实值——
 * "token 显示不超真实值"验收的数据依据；热路径由 TokenCounter 叶子组件持 tick 消费。
 */

export function nextTokenCatchUp(displayed: number, real: number): number {
  if (displayed >= real) return real
  const step = Math.max(1, Math.ceil((real - displayed) / 4))
  return Math.min(real, displayed + step)
}
