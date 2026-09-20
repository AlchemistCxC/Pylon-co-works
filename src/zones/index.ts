/** 区域层门面：对外统一导出。 */

export { pickZoneFields } from './pickZoneFields.ts'
export {
  ZONE_PRESET_POOL,
  cleanupZonePresetEntries,
  createZonePresetEntryId,
  deriveZonePresetPool,
  isCustomZonePresetEntry,
  normalizeZonePresetEntries,
  normalizeZonePresetValues,
  removeZonePresetEntryReducer,
  resolveZonePresetEntryTheme,
  zonePresetsFor,
} from './zonePresetPool.ts'
export type { ZonePresetEntry, ZonePresetPool, ZonePresetRemovalPatch, ZonePresetRemovalState } from './zonePresetPool.ts'
