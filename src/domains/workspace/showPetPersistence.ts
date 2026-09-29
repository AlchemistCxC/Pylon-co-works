/**
 * showPetPersistence — 宠物显隐偏好持久化（W1-01 方案 B）。
 *
 * showPet 迁出主题层（预设不覆盖布局偏好），存 workspaceStore 独立 localStorage key，
 * 非 sheet envelope 持久字段；缺省 true。独立 roundtrip 可测。
 */

export const SHOW_PET_STORAGE_KEY = 'pylon-workspace-show-pet'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function readShowPet(storage: StorageLike): boolean {
  try {
    const raw = storage.getItem(SHOW_PET_STORAGE_KEY)
    if (raw == null) return true
    return raw === 'true'
  } catch {
    return true
  }
}

export function writeShowPet(storage: StorageLike, show: boolean): void {
  try {
    storage.setItem(SHOW_PET_STORAGE_KEY, String(show))
  } catch {
    // 存储不可用：静默（内存态仍生效）
  }
}
