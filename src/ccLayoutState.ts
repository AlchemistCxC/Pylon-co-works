import { CC_WIDGET_GROUPS } from './domains/cc/widgetDefinitions.ts'
import type { CcRegisteredSlotId, CcWidgetId } from './domains/cc/widgetDefinitions.ts'

export type { CcRegisteredSlotId, CcWidgetId } from './domains/cc/widgetDefinitions.ts'
export { CC_REGISTERED_SLOT_IDS } from './domains/cc/widgetDefinitions.ts'
export type CcSlot = 'input' | 'status-primary' | 'status-secondary' | 'actions'

/**
 * `CC_REGISTERED_SLOT_IDS`（注册轨里**占槽位**的控件 id，F1=A：legacy `send` 的槽位事实
 * 迁到这里）由 `domains/cc/widgetDefinitions.ts` 的定义表派生后在此转出：
 * 注册轨的另一项 `cc-surface`（「基础」）不开槽位、无 order/offset、无显隐，故不在名单内。
 */

/** 能落槽位的控件 id = 内置轨 ∪ 注册轨中占槽位者。 */
export type CcLayoutWidgetId = CcWidgetId | CcRegisteredSlotId

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
// 归一化时按别名读取，保留用户既有拖拽位置）。
//
// ★★ 版本号职责（#238 刀2 起收窄 —— **后来者请勿再往这里塞东西**）：
// `CC_LAYOUT_SCHEMA_VERSION` **只表示「数据格式版本」**。★ **反例：加控件、改槽位、
// 改 id 都不需要 bump** —— 结构对齐（补缺项/按 id 合并）由读盘路径每次无条件跑，
// 与版本号无关（`alignThemeStructure`，见 `domains/theme/migration.ts`）。
// 历史上这里曾有一份**版本白名单**（`[3,4,5,6,7,8,当前版本]`）用来决定"要不要采用老数据"，
// 它内插了「当前版本」这个变量 ⇒ 每次升版本号就自动少一项，v7 就这么被漏掉过
// （磁盘上版本 7 的布局被**整份丢弃、回落默认、不报错**）。刀2 把整段判定删掉：
// 版本号不再参与"用不用老数据"，只在下述一次性语义转换时才有意义。
export const CC_LAYOUT_SCHEMA_VERSION = 9

/**
 * 默认布局 —— 由定义表各行的 `defaultPlacement` 派生（值逐条不变）。
 * 只有**占槽位**的行才有 `defaultPlacement`（`cc-surface` 是容器，不占位）；
 * 键序 = 表序（input → model → reasoning → mode → tokens → cc-send-button）。
 */
const DEFAULT_PLACEMENTS = {} as Record<CcLayoutWidgetId, CcWidgetPlacement>
for (const row of CC_WIDGET_GROUPS) {
  if (row.defaultPlacement) DEFAULT_PLACEMENTS[row.id as CcLayoutWidgetId] = { ...row.defaultPlacement }
}

export const DEFAULT_CC_LAYOUT: CcLayoutV3 = {
  version: CC_LAYOUT_SCHEMA_VERSION,
  placements: DEFAULT_PLACEMENTS,
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

/**
 * 布局归一化（**按 id 合并**）：缺项补默认、多余项忽略、用户手调值一律保留。
 *
 * ★ #238 刀2：**不再按版本号决定"要不要采用老数据"** —— 版本号与结构对齐无关。
 * 本函数由读盘路径**每次读盘无条件跑一次**（`store.ts` 的 persist `merge` →
 * `alignThemeStructure`），所以「加了新控件但忘记 bump 版本号 ⇒ 控件永远不出现」
 * 这类静默事故在结构上不可能再发生；磁盘上版本号是垃圾值/未来值也不会整份重置。
 *
 * 保留的合并规则（与 `updateCcPlacementState` 同语义）：
 * - 只遍历**当前控件全集**（`DEFAULT_CC_LAYOUT` 的键）⇒ 缺项补默认、旧 id 自然丢弃；
 * - 已存在的项保留其 `slot` / `order` / `offsetX` / `offsetY`（只做范围 clamp）；
 * - legacy `send` 键按别名读入（v9 键名迁移，与版本号无关、幂等）；
 * - 槽位语义修复：`input` 槽只属于 input 控件，非 input 落在 input 槽会渲染消失 ⇒ 回落默认槽位。
 */
export function normalizeCcLayout(layout: Partial<CcLayoutV3> | null | undefined): CcLayoutV3 {
  const placements = cloneCcLayout(DEFAULT_CC_LAYOUT).placements
  if (!layout?.placements) return { version: CC_LAYOUT_SCHEMA_VERSION, placements }

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
