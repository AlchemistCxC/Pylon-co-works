/** 区域层 · 按 zone 提取主题字段子集。 */

import type { ThemeSettings } from '../store.ts'
import { ZONE_FIELDS } from '../themeFieldDefs.ts'

/** 从预设里提取指定 zone 的字段子集 */
export function pickZoneFields(
  theme: Partial<ThemeSettings>,
  zone: string,
): Partial<ThemeSettings> {
  const fields = ZONE_FIELDS[zone] ?? []
  return Object.fromEntries(
    fields.filter((f): f is keyof ThemeSettings => f in theme).map(f => [f, theme[f]]),
  ) as Partial<ThemeSettings>
}
