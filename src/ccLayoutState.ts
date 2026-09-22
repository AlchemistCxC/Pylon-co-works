import { CC_WIDGET_GROUPS } from './domains/cc/widgetDefinitions.ts'
import type { CcRegisteredSlotId, CcWidgetId } from './domains/cc/widgetDefinitions.ts'

export type { CcRegisteredSlotId, CcWidgetId } from './domains/cc/widgetDefinitions.ts'
export { CC_REGISTERED_SLOT_IDS } from './domains/cc/widgetDefinitions.ts'

/**
 * ★ #238 刀3：**槽位层整体拆除**。原来的 `CcSlot`（输入区/状态左/状态右/操作区）、
 * `SLOT_SET` 白名单、以及 `placement.slot` 字段都不存在了 ——
 * 位置改由定义表每行的 `layout`（x 轴贴谁 + y 轴贴谁 + 组内序号）声明，
 * 渲染按「落脚处 = (y.anchor, y.side)」自动成组（`ccWidgetLanding`）。
 * 详见 `domains/cc/widgetDefinitions.ts`。
 */

/** 能落槽位的控件 id = 内置轨 ∪ 注册轨中占槽位者。 */
export type CcLayoutWidgetId = CcWidgetId | CcRegisteredSlotId

/**
 * 一个元件在**用户数据**里的位置：只存可变部分（组内序号 + 两个方向的微调）。
 *
 * ★ #238 刀3：槽位层已拆，`slot` **不再是位置真值**（位置由定义表 `layout` 声明）。
 * 这里保留一个**只读的历史键** `slot?: string` 有两个实际原因，且运行时**一律不读**它：
 * 1. 老用户 localStorage 里带着它（用户口径：**不写迁移、不做适配**）；
 * 2. 出厂区域预设的落盘数据（`zones/factory/**`，生成脚本已删、文件头写明请勿手改）里带着它，
 *    而那份数据的类型是 `Partial<ThemeSettings>` —— 删掉本键会让它直接变成编译错误。
 * `normalizeCcLayout` 只取 `order` / `offsetX` / `offsetY`，其余键（含 `slot`）自然丢弃。
 */
export interface CcWidgetPlacement {
  /** @deprecated 历史键（槽位时代的 `input`/`status-primary`/`status-secondary`/`actions`），永不读取。 */
  readonly slot?: string
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
// ★ #238 刀3：**槽位层退场** —— `slot` 字段不再存在；读盘时老数据里的 `slot` 一律不读、
// 其余（order/offsetX/offsetY）原样保留（不写迁移，用户口径）。序号从「槽内序号」变成
// 「同落脚处组内序号」——老数据的相对顺序不变 ⇒ 效果等价。
//
// ★★ 版本号职责（#238 刀2 起收窄 —— **后来者请勿再往这里塞东西**）：
// `CC_LAYOUT_SCHEMA_VERSION` **只表示「数据格式版本」**。★ **反例：加控件、改位置声明、
// 改 id 都不需要 bump** —— 结构对齐（补缺项/按 id 合并）由读盘路径每次无条件跑，
// 与版本号无关（`alignThemeStructure`，见 `domains/theme/migration.ts`）。
// 刀3 拆掉 slot 字段**也没有 bump**：消失的字段由「每次读盘归一化」自然消化。
export const CC_LAYOUT_SCHEMA_VERSION = 9

/**
 * 默认布局 —— 由定义表各行的 `layout.order` 派生（只取**可拖**的行：容器不占位、
 * 「命令行提示」结构步不可拖）。
 * 元件**贴哪一行/哪一侧**不在用户数据里（它由定义表声明），这里只存可变部分：
 * 组内序号 + 两个方向的微调（默认 0）。
 */
const DEFAULT_PLACEMENTS = {} as Record<CcLayoutWidgetId, CcWidgetPlacement>
for (const row of CC_WIDGET_GROUPS) {
  if (row.draggable && row.layout) {
    DEFAULT_PLACEMENTS[row.id as CcLayoutWidgetId] = { order: row.layout.order, offsetX: 0, offsetY: 0 }
  }
}

export const DEFAULT_CC_LAYOUT: CcLayoutV3 = {
  version: CC_LAYOUT_SCHEMA_VERSION,
  placements: DEFAULT_PLACEMENTS,
}

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
 * ★ #238 刀3：**槽位判定已整段删除** —— 老数据里读到的 `slot` 字段**一律不读**（不写迁移、
 * 不做适配，用户口径）；`order` / `offsetX` / `offsetY` 原样保留。
 *
 * 保留的合并规则：
 * - 只遍历**当前可拖元件全集**（`DEFAULT_CC_LAYOUT` 的键）⇒ 缺项补默认、旧 id 自然丢弃；
 * - 已存在的项保留其 `order` / `offsetX` / `offsetY`（只做范围 clamp）；
 * - legacy `send` 键按别名读入（v9 键名迁移，与版本号无关、幂等）。
 */
export function normalizeCcLayout(layout: Partial<CcLayoutV3> | null | undefined): CcLayoutV3 {
  const placements = cloneCcLayout(DEFAULT_CC_LAYOUT).placements
  if (!layout?.placements) return { version: CC_LAYOUT_SCHEMA_VERSION, placements }

  const legacyPlacements = layout.placements as Record<string, Partial<CcWidgetPlacement> | undefined>
  for (const id of Object.keys(placements) as CcLayoutWidgetId[]) {
    // v9：legacy `send` 键 → 注册轨 id（槽位改名不改位置）
    const candidate = legacyPlacements[id]
      ?? (id === 'cc-send-button' ? legacyPlacements.send : undefined)
    if (!candidate) continue
    placements[id] = {
      order: Math.round(clamp(candidate.order as number, 0, 99)),
      offsetX: clamp(candidate.offsetX as number, -48, 48),
      offsetY: clamp(candidate.offsetY as number, -16, 16),
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
  const next: CcWidgetPlacement = {
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
