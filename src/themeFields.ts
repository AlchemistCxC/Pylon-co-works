/**
 * themeFields — 主题字段单一真值表（阶段 3 声明式 → 骨架化）。
 *
 * 现为 themeFieldDefs.ts（THEME_FIELD_DEFS 类型化定义）的兼容出口：
 * 旧导入路径（presets/customPresets/themeMigration/store）继续可用，
 * 真值源在 themeFieldDefs.ts。
 */

import { ZONES, ZONE_FIELDS, THEME_SETTING_KEYS } from './themeFieldDefs.ts'

export { ZONES, ZONE_FIELDS, THEME_SETTING_KEYS }

/** 旧名兼容：zone → 字段映射 */
export const THEME_FIELD_GROUPS = ZONE_FIELDS

/** 旧名兼容：customPresets.ts 引用 THEME_SETTINGS_KEYS（复数） */
export const THEME_SETTINGS_KEYS = THEME_SETTING_KEYS
