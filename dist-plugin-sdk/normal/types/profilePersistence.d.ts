/**
 * profilePersistence — Profile 独立持久化（FE-AUD-002 / 阶段 1B）。
 *
 * versioned envelope `pylon-profiles`：profiles + activeProfileId。
 * normalize 拒绝空 id、重复 id 与损坏对象；损坏/缺失回退 defaults。
 * 旧 pylon-theme 内嵌 profile 由调用方一次性迁移落本 key（见 identityStore.hydrateProfiles）。
 */
export interface PersistedProfile {
    id: string;
    name: string;
    persona: string;
    model: string;
    avatar?: string;
}
export interface ProfilePersistenceState<T extends PersistedProfile = PersistedProfile> {
    profiles: T[];
    activeProfileId: string;
}
/** 历史 schema 版本引用（保留；主题域注释引用） */
export declare const PROFILE_SCHEMA_VERSION = 4;
/** pylon-profiles envelope 版本 */
export declare const PROFILE_ENVELOPE_VERSION = 1;
export declare const PROFILE_STORAGE_KEY = "pylon-profiles";
interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}
/** 单 profile 规范化：拒绝空 id 与损坏对象 */
export declare function normalizePersistedProfile(raw: unknown): PersistedProfile | null;
/** 宽容列表规范化（legacy 契约）：profiles 非空则原样保留，仅做 active fallback */
export declare function normalizeProfileState<T extends PersistedProfile>(profiles: T[], activeProfileId: string, defaults: T[]): ProfilePersistenceState<T>;
/** 解析 envelope：逐条严格 normalize（拒绝空 id/损坏，重复 id 保留首个）+ 宽容聚合；缺失/损坏回退 defaults */
export declare function parseProfileEnvelope(raw: string | null, defaults: PersistedProfile[]): ProfilePersistenceState;
export declare function serializeProfileEnvelope(state: ProfilePersistenceState): string;
export declare function persistProfiles(storage: StorageLike, state: ProfilePersistenceState): boolean;
export declare function loadProfiles(storage: StorageLike, defaults: PersistedProfile[]): ProfilePersistenceState;
export {};
