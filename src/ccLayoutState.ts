export type CcWidgetId = 'input' | 'ekg' | 'pct' | 'tokens' | 'context-ring' | 'runtime-status' | 'model' | 'mode' | 'send' | 'attach'
export type CcSlot = 'input' | 'status-primary' | 'status-secondary' | 'actions'

export interface CcWidgetPlacement {
  slot: CcSlot
  order: number
  offsetX: number
  offsetY: number
}

export interface CcLayoutV3 {
  version: number
  placements: Record<CcWidgetId, CcWidgetPlacement>
}

// v5：新增 runtime-status，保留旧 placement 并补齐新控件默认位置。
export const CC_LAYOUT_SCHEMA_VERSION = 5

export const DEFAULT_CC_LAYOUT: CcLayoutV3 = {
  version: CC_LAYOUT_SCHEMA_VERSION,
  placements: {
    input: { slot: 'input', order: 0, offsetX: 0, offsetY: 0 },
    ekg: { slot: 'status-primary', order: 0, offsetX: 0, offsetY: 0 },
    pct: { slot: 'status-primary', order: 1, offsetX: 0, offsetY: 0 },
    tokens: { slot: 'status-primary', order: 2, offsetX: 0, offsetY: 0 },
    'context-ring': { slot: 'status-primary', order: 3, offsetX: 0, offsetY: 0 },
    'runtime-status': { slot: 'status-secondary', order: 0, offsetX: 0, offsetY: 0 },
    model: { slot: 'status-secondary', order: 1, offsetX: 0, offsetY: 0 },
    mode: { slot: 'status-secondary', order: 2, offsetX: 0, offsetY: 0 },
    send: { slot: 'actions', order: 0, offsetX: 0, offsetY: 0 },
    attach: { slot: 'actions', order: 1, offsetX: 0, offsetY: 0 },
  },
}

const SLOT_SET = new Set<CcSlot>(['input', 'status-primary', 'status-secondary', 'actions'])
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0))

export function cloneCcLayout(layout: CcLayoutV3): CcLayoutV3 {
  return {
    version: CC_LAYOUT_SCHEMA_VERSION,
    placements: Object.fromEntries(
      Object.entries(layout.placements).map(([id, placement]) => [id, { ...placement }]),
    ) as Record<CcWidgetId, CcWidgetPlacement>,
  }
}

export function normalizeCcLayout(layout: Partial<CcLayoutV3> | null | undefined): CcLayoutV3 {
  const placements = cloneCcLayout(DEFAULT_CC_LAYOUT).placements
  if (!layout?.placements || ![3, 4, CC_LAYOUT_SCHEMA_VERSION].includes(layout.version ?? 0)) {
    return { version: CC_LAYOUT_SCHEMA_VERSION, placements }
  }

  for (const id of Object.keys(placements) as CcWidgetId[]) {
    const candidate = layout.placements[id]
    if (!candidate) continue
    placements[id] = {
      slot: SLOT_SET.has(candidate.slot) ? candidate.slot : placements[id].slot,
      order: Math.round(clamp(candidate.order, 0, 99)),
      offsetX: clamp(candidate.offsetX, -48, 48),
      offsetY: clamp(candidate.offsetY, -16, 16),
    }
  }
  return { version: CC_LAYOUT_SCHEMA_VERSION, placements }
}

export function updateCcPlacementState(
  layout: CcLayoutV3,
  id: string,
  partial: Partial<CcWidgetPlacement>,
): CcLayoutV3 {
  const current = layout.placements[id as CcWidgetId]
  if (!current) return layout
  const slot = partial.slot && SLOT_SET.has(partial.slot) ? partial.slot : current.slot
  const next: CcWidgetPlacement = {
    slot,
    order: partial.order == null ? current.order : Math.round(clamp(partial.order, 0, 99)),
    offsetX: partial.offsetX == null ? current.offsetX : clamp(partial.offsetX, -48, 48),
    offsetY: partial.offsetY == null ? current.offsetY : clamp(partial.offsetY, -16, 16),
  }
  return {
    version: CC_LAYOUT_SCHEMA_VERSION,
    placements: { ...layout.placements, [id]: next },
  }
}

export function setCcHiddenState(hiddenIds: string[], id: string, hidden: boolean): string[] {
  return hidden
    ? Array.from(new Set([...hiddenIds, id]))
    : hiddenIds.filter(widgetId => widgetId !== id)
}

export function setCcScaleState(scales: Record<string, number>, id: string, scale: number): Record<string, number> {
  return { ...scales, [id]: Math.max(50, Math.min(200, scale)) }
}
