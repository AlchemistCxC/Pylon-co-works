export interface ContextMeterPalette {
  ok: string
  warning: string
  danger: string
}

export interface ContextMeterInput {
  used: number
  max: number
  palette: ContextMeterPalette
}

export interface ContextMeterState {
  ratio: number
  percentage: number
  color: string
  label: string
}

const FALLBACK_PALETTE: ContextMeterPalette = {
  ok: '#34d399',
  warning: '#fbbf24',
  danger: '#f87171',
}

export function clampContextRatio(used: number, max: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return 0
  return Math.max(0, Math.min(1, used / max))
}

export function resolveContextMeter({ used, max, palette }: ContextMeterInput): ContextMeterState {
  const ratio = clampContextRatio(used, max)
  const percentage = Math.round(ratio * 100)
  const colors = {
    ok: palette.ok || FALLBACK_PALETTE.ok,
    warning: palette.warning || FALLBACK_PALETTE.warning,
    danger: palette.danger || FALLBACK_PALETTE.danger,
  }
  const color = ratio < 0.5 ? colors.ok : ratio < 0.8 ? colors.warning : colors.danger

  return {
    ratio,
    percentage,
    color,
    label: `上下文 ${percentage}%`,
  }
}
