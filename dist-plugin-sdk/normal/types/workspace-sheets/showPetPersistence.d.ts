/**
 * showPetPersistence — 宠物显隐偏好持久化（W1-01 方案 B）。
 *
 * showPet 迁出主题层（预设不覆盖布局偏好），存 workspaceStore 独立 localStorage key，
 * 非 sheet envelope 持久字段；缺省 true。独立 roundtrip 可测。
 */
export declare const SHOW_PET_STORAGE_KEY = "pylon-workspace-show-pet";
export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}
export declare function readShowPet(storage: StorageLike): boolean;
export declare function writeShowPet(storage: StorageLike, show: boolean): void;
