/**
 * 区域层 · 预设的「有效值」视图（刀3 / #223）。
 *
 * 刀3 消灭了「值存两份」：`GlobalPreset.theme` 不再手写，10 套出厂预设**只写区域引用表**
 * （`zoneRefs`），它们的有效值由本函数**算出来**——把 5 个区域的工厂数据切片并起来。
 *
 * 语义（两条分支）：
 * - **写了 `theme`**（两条默认预设，走"直给"路径）⇒ 直接用；
 * - **只写 `zoneRefs`**（10 套出厂预设）⇒ 5 个区域的工厂数据切片之并集。
 *
 * ★★ **本文件不得 import `src/presets/**` 的运行时导出** —— `presets/` → `zones/` 已是既有方向
 * （`zones/zonePresetPool.ts` 反过来 import 桶表），反向的**运行时**依赖会成模块环。
 * 所以入参是**调用方传进来的预设对象本身**（结构性类型），
 * 只做 `PresetInterfaceMode` / `ZoneRefMap` / `ThemeSettings` 这几个**类型**进口（`import type` 类型擦除，不产生运行时边）。
 *
 * ★ 零变化的依据（刀1 + 刀2 已各自证过，本文件因此只需"并"、不需"算"）：
 *   刀1 证「装配结果 == 旧路径 patch」；刀2 证「工厂数据 == `pickZoneFields(preset.theme, zone)` 逐字段」
 *   ⇒ 五片并集 == 原 `theme`（前提：`theme` 里没有不属于任何区域的键 —— 开工已实测：一个都没有）。
 */

import type { ThemeSettings } from '../store.ts'
import type { PresetInterfaceMode } from '../presets/types.ts'
import {
  PRESET_ZONES,
  requireZoneRefs,
  type ZoneRefMap,
} from '../domains/theme/presetReducer.ts'
import { ZONE_PRESET_POOL, resolveZonePresetEntryTheme } from './zonePresetPool.ts'

/**
 * 计算所需的最小输入面。结构性类型 ⇒ 调用方可以直接把 `GlobalPreset` 递进来，
 * 本模块不需要（也不许）依赖 `presets/` 的运行时导出。
 */
export interface ZoneRefBackedPreset {
  readonly interfaceMode: PresetInterfaceMode
  /** 5 个区域 → 区域预设 id。有值 ⇒ 有效值由引用表算出。 */
  readonly zoneRefs?: ZoneRefMap
  /** 直给的有效值（两条默认预设）。与 `zoneRefs` 至少有一个。 */
  readonly theme?: Partial<ThemeSettings>
}

/**
 * 这套预设的**有效值**（= 它实际会写进主题的那些字段）。
 *
 * 引用表里的 id 必须能在**同桶同区域**解析到（跨桶 / 跨区域 / 不存在的引用**抛错**，
 * 与刀1 的 `expandGlobalPresetZoneRefs` 同一口径、同一错误语义）。
 * 出厂数据的越区键在刀2 的池装配期已校验过，这里不重复（一次构建期闸门足够）。
 */
export function effectivePresetTheme(preset: ZoneRefBackedPreset): Partial<ThemeSettings> {
  if (!preset.zoneRefs) return preset.theme ?? {}

  const refs = requireZoneRefs(preset.zoneRefs, `预设 ${preset.interfaceMode} 的区域引用表`)
  const merged: Record<string, unknown> = {}
  for (const zone of PRESET_ZONES) {
    const presetId = refs[zone]
    const entry = ZONE_PRESET_POOL[preset.interfaceMode][zone].find(candidate => candidate.id === presetId)
    const values = entry ? resolveZonePresetEntryTheme(entry) : null
    if (!values) throw new Error(`区域引用解析不到：${preset.interfaceMode}/${zone} → ${presetId}`)
    Object.assign(merged, values)
  }
  return merged as Partial<ThemeSettings>
}
