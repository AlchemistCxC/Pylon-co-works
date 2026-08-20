export type CliOverflowMode = 'fixed-scroll' | 'grow' | 'overlay'

export interface CliTextareaLayout {
  height: number
  overflowY: 'hidden' | 'auto'
  expanded: boolean
}

const SINGLE_LINE_HEIGHT = 22
const MAX_EXPANDED_HEIGHT = 200

export function resolveCliTextareaLayout(scrollHeight: number, mode: CliOverflowMode): CliTextareaLayout {
  const safeScrollHeight = Number.isFinite(scrollHeight) ? Math.max(SINGLE_LINE_HEIGHT, scrollHeight) : SINGLE_LINE_HEIGHT
  if (mode === 'fixed-scroll') {
    return {
      height: SINGLE_LINE_HEIGHT,
      overflowY: safeScrollHeight > SINGLE_LINE_HEIGHT ? 'auto' : 'hidden',
      expanded: false,
    }
  }

  const height = Math.min(safeScrollHeight, MAX_EXPANDED_HEIGHT)
  return {
    height,
    overflowY: safeScrollHeight > MAX_EXPANDED_HEIGHT ? 'auto' : 'hidden',
    expanded: height > SINGLE_LINE_HEIGHT,
  }
}

export function resolveDefaultTextareaHeight(scrollHeight: number): number {
  return Math.min(Number.isFinite(scrollHeight) ? Math.max(SINGLE_LINE_HEIGHT, scrollHeight) : SINGLE_LINE_HEIGHT, MAX_EXPANDED_HEIGHT)
}
