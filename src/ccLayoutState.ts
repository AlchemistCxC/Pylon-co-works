export interface CcPosition {
  x: number
  y: number
  w?: number
  h?: number
}

export type CcPositions = Record<string, CcPosition>

export const CC_LAYOUT_SCHEMA_VERSION = 2
export const NATURAL_CC_WIDGET_IDS = new Set(['ekg', 'pct', 'tokens', 'model', 'mode', 'send', 'attach'])

export function normalizeCcPositions(positions: CcPositions | null | undefined, defaults: CcPositions): CcPositions {
  const merged = { ...cloneCcPositions(defaults), ...(positions || {}) }
  return Object.fromEntries(Object.entries(merged).map(([id, position]) => {
    if (!NATURAL_CC_WIDGET_IDS.has(id)) return [id, { ...position }]
    return [id, { x: position.x, y: position.y }]
  }))
}

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
