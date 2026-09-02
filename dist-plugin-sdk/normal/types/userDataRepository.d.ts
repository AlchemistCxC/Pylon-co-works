export type UserDataKey = 'profiles' | 'sessions';
/** 已存储 envelope 的 wire 形状（后端 UserDataEnvelope camelCase；payload 自描述含 version）。 */
export interface UserDataEnvelope {
    version: number;
    revision: number;
    payload: Record<string, unknown>;
}
/** 保存结果 wire 形状（后端 UserDataSaveResult）：新 revision（后续 expected 基准）。 */
export interface UserDataSaveResult {
    revision: number;
}
/** 写失败结构化错误：code 供分支（user_data_revision_conflict / user_data_unavailable / user_data_corrupt）。 */
export declare class UserDataRepositoryError extends Error {
    readonly code: string | undefined;
    constructor(code: string | undefined, message: string);
}
/** Tauri invoke 拒绝值（后端 {code,message} 结构化错误）→ UserDataRepositoryError。 */
export declare function asUserDataRepositoryError(error: unknown): UserDataRepositoryError;
/** invoke 失败必须以 reject 传播（归一化，不得把失败变成功）。 */
export declare function rejectUserDataError(error: unknown): never;
/** I14-W7：Profile 删除结果（后端单事务 fallback/重绑定/activeProfileId）。 */
export interface ProfileDeleteResult {
    fallback: string;
    profilesRevision: number;
    sessionsRevision: number | null;
}
/** 用户数据持久化 client（load/save/deleteProfile）。 */
export interface UserDataRepository {
    /** 读取 key 对应 envelope；无数据返回 null（顺带推进 revision baseline）。 */
    load(key: UserDataKey): Promise<UserDataEnvelope | null>;
    /** 保存 envelope（自描述含 version）；返回最新 revision。 */
    save(key: UserDataKey, envelope: Record<string, unknown>): Promise<number>;
    /** I14-W7：后端原子删除 Profile（fallback/重绑定/activeProfileId 单事务）。 */
    deleteProfile(profileId: string): Promise<ProfileDeleteResult>;
    /** 等待全部 per-key 串行链落定（关闭前 flush / 测试收敛）。 */
    flush(): Promise<void>;
}
/** tauri adapter：typed invoke → 后端 SQLite UserDataStore。 */
export declare function tauriUserDataRepository(): UserDataRepository;
/** composition root 选择器：Tauri 走后端 versioned user store；否则 null（browser 模式
 * identityStore 直接同步读写 localStorage，不经本仓库）。 */
export declare function selectUserDataRepository(): UserDataRepository | null;
