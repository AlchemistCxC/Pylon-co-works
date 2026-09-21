/**
 * 区域层 · 出厂区域预设数据索引（刀2 / #223）。
 *
 * 10 个数据文件（2 桶 × 5 区域）在这里拼成一张扁平表，供 `zonePresetPool.ts` 装配成池。
 * 每个数据文件由 `scripts/generate-factory-zone-presets.mts --write` 产出，**不要手改**；
 * 校验走同一脚本的默认模式。
 *
 * 键序固定为「桶 → 区域」，与 `PRESET_ZONES` 的顺序一致 ⇒ 池里每格的条目顺序稳定。
 */

import type { ZonePresetEntry } from '../zonePresetPool.ts'
import { FACTORY_GUI_CHAT } from './gui-chat.ts'
import { FACTORY_GUI_CC } from './gui-cc.ts'
import { FACTORY_GUI_GLOBAL } from './gui-global.ts'
import { FACTORY_GUI_RIGHT } from './gui-right.ts'
import { FACTORY_GUI_SIDEBAR } from './gui-sidebar.ts'
import { FACTORY_TERMINAL_CHAT } from './terminal-chat.ts'
import { FACTORY_TERMINAL_CC } from './terminal-cc.ts'
import { FACTORY_TERMINAL_GLOBAL } from './terminal-global.ts'
import { FACTORY_TERMINAL_RIGHT } from './terminal-right.ts'
import { FACTORY_TERMINAL_SIDEBAR } from './terminal-sidebar.ts'

export const FACTORY_ZONE_PRESET_ENTRIES: readonly ZonePresetEntry[] = Object.freeze([
  ...FACTORY_GUI_GLOBAL,
  ...FACTORY_GUI_SIDEBAR,
  ...FACTORY_GUI_CHAT,
  ...FACTORY_GUI_CC,
  ...FACTORY_GUI_RIGHT,
  ...FACTORY_TERMINAL_GLOBAL,
  ...FACTORY_TERMINAL_SIDEBAR,
  ...FACTORY_TERMINAL_CHAT,
  ...FACTORY_TERMINAL_CC,
  ...FACTORY_TERMINAL_RIGHT,
])
