import { type CcWidgetId } from './domains/cc/widgetDefinitions.ts'

export type { CcWidgetId } from './domains/cc/widgetDefinitions.ts'
export type CcSlot = 'input' | 'status-primary' | 'status-secondary' | 'actions'

/**
 * 注册轨里**占槽位**的控件 id（F1=A：legacy `send` 的槽位事实迁到这里）。
 * 注册轨的另一项 `cc-surface`（「基础」）不开槽位、无 order/offset、无显隐，故不在名单内。
 */
export const CC_REGISTERED_SLOT_IDS = ['cc-send-button'] as const

/** 能落槽位的控件 id = 内置轨 ∪ 注册轨中占槽位者。 */
export type CcLayoutWidgetId = CcWidgetId | (typeof CC_REGISTERED_SLOT_IDS)[number]

export interface CcWidgetPlacement {
  slot: CcSlot
  order: number
  offsetX: number
  offsetY: number
}

export interface CcLayoutV3 {
  version: number
  placements: Record<CcLayoutWidgetId, CcWidgetPlacement>
}

// v7：新增会话、工作区与运行状态控件；旧布局按 ID 保留并补入新增默认位置。
// v8：删除 pct 控件（并入「用量」tokens 控件）；用量控件默认移到状态区次行、紧跟权限控件。
// v9：中控名单换代（旧 11 → 新 7）——删 session/workspace/activity/ekg/tasks 五个 id；
// legacy `send` 的槽位事实迁到注册轨 id `cc-send-button`（老数据里的 `send` 键在
// 归一化时按别名读取，保留用户既有拖拽位置）。★ v8 仍在版本白名单内，老布局不重置。
export const CC_LAYOUT_SCHEMA_VERSION = 9

export const DEFAULT_CC_LAYOUT: CcLayoutV3 = {
  version: CC_LAYOUT_SCHEMA_VERSION,
  placements: {
    input: { slot: 'input', order: 0, offsetX: 0, offsetY: 0 },
    model: { slot: 'status-secondary', order: 2, offsetX: 0, offsetY: 0 },
    reasoning: { slot: 'status-secondary', order: 3, offsetX: 0, offsetY: 0 },
    mode: { slot: 'status-secondary', order: 4, offsetX: 0, offsetY: 0 },
    tokens: { slot: 'status-secondary', order: 5, offsetX: 0, offsetY: 0 },
    'cc-send-button': { slot: 'actions', order: 0, offsetX: 0, offsetY: 0 },
  },
}

const SLOT_SET = new Set<CcSlot>(['input', 'status-primary', 'status-secondary', 'actions'])
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0))

export function cloneCcLayout(layout: CcLayoutV3): CcLayoutV3 {
  return {
    version: CC_LAYOUT_SCHEMA_VERSION,
    placements: Object.fromEntries(
      Object.entries(layout.placements).map(([id, placement]) => [id, { ...placement }]),
    ) as Record<CcLayoutWidgetId, CcWidgetPlacement>,
  }
}

export function normalizeCcLayout(layout: Partial<CcLayoutV3> | null | undefined): CcLayoutV3 {
  const placements = cloneCcLayout(DEFAULT_CC_LAYOUT).placements
  // ★ 白名单显式列出历史版本：`8` 必须留在这里，否则常量 8→9 会让老 v8 布局
  // 整份回落默认值（用户排布静默丢失）。
  if (!layout?.placements || ![3, 4, 5, 6, 7, 8, CC_LAYOUT_SCHEMA_VERSION].includes(layout.version ?? 0)) {
    return { version: CC_LAYOUT_SCHEMA_VERSION, placements }
  }

  const legacyPlacements = layout.placements as Record<string, CcWidgetPlacement | undefined>
  for (const id of Object.keys(placements) as CcLayoutWidgetId[]) {
    // v9：legacy `send` 键 → 注册轨 id（槽位改名不改位置）
    const candidate = legacyPlacements[id]
      ?? (id === 'cc-send-button' ? legacyPlacements.send : undefined)
    if (!candidate) continue
    // 槽位语义与 updateCcPlacementState 保持一致：input 槽只属于 input widget，
    // 旧数据里"非 input 在 input 槽"会渲染消失，归一化时回落到默认槽位。
    const candidateSlot = SLOT_SET.has(candidate.slot) ? candidate.slot : placements[id].slot
    const slot = id === 'input'
      ? candidateSlot === 'input' ? 'input' : placements[id].slot
      : candidateSlot === 'input' ? placements[id].slot : candidateSlot
    placements[id] = {
      slot,
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
  const current = layout.placements[id as CcLayoutWidgetId]
  if (!current) return layout
  const requestedSlot = partial.slot && SLOT_SET.has(partial.slot) ? partial.slot : undefined
  // 槽位语义校验：input 槽只属于 input widget（其他 widget 移入会被渲染过滤而消失），
  // input widget 不得移出 input 槽（input 始终渲染在 cc-input-slot）。
  const slot = id === 'input'
    ? requestedSlot === 'input' ? 'input' : current.slot
    : requestedSlot === 'input' ? current.slot : (requestedSlot ?? current.slot)
  const next: CcWidgetPlacement = {
    slot,
    order: partial.order == null || !Number.isFinite(partial.order) ? current.order : Math.round(clamp(partial.order, 0, 99)),
    offsetX: partial.offsetX == null || !Number.isFinite(partial.offsetX) ? current.offsetX : clamp(partial.offsetX, -48, 48),
    offsetY: partial.offsetY == null || !Number.isFinite(partial.offsetY) ? current.offsetY : clamp(partial.offsetY, -16, 16),
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
  if (!Number.isFinite(scale)) return scales
  return { ...scales, [id]: Math.max(50, Math.min(200, scale)) }
}
