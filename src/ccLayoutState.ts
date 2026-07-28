export interface CcPosition {
  x: number
  y: number
  w: number
  h: number
}

export type CcPositions = Record<string, CcPosition>

export function updateCcPositionState(
  positions: CcPositions,
  defaults: CcPositions,
  id: string,
  partial: Partial<CcPosition>,
): CcPositions {
  const current = positions[id] || defaults[id]
  if (!current) return positions
  return { ...positions, [id]: { ...current, ...partial } }
}

export function cloneCcPositions(positions: CcPositions): CcPositions {
  return Object.fromEntries(
    Object.entries(positions).map(([id, position]) => [id, { ...position }]),
  )
}

export function setCcHiddenState(hiddenIds: string[], id: string, hidden: boolean): string[] {
  return hidden
    ? Array.from(new Set([...hiddenIds, id]))
    : hiddenIds.filter(widgetId => widgetId !== id)
}

export function setCcScaleState(scales: Record<string, number>, id: string, scale: number): Record<string, number> {
  return { ...scales, [id]: Math.max(50, Math.min(200, scale)) }
}
