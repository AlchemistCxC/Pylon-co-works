import type { PersistedProfile } from './profilePersistence.js';
import type { Session, Turn } from './identityStore.js';
import type { SessionCreationSnapshot } from './plugin-runtime/session-creation/sessionCreationTypes.js';
export type PersistedSession = Session;
export declare const SESSION_SCHEMA_VERSION = 3;
export declare const SESSION_STORAGE_KEY = "pylon-sessions";
export declare const LEGACY_SESSION_STORAGE_KEY = "prism-sessions";
/** v1 遗留会话形状（无 agentId）：迁移时用于 owner 推断；无法唯一确定时进入 needs-owner-resolution */
export interface LegacySession {
    id: string;
    periId?: string;
    name: string;
    source: string;
    profileId: string;
    createdAt: number;
    lastActiveAt: number;
    lastReplyAt?: number;
    archivedAt?: number;
    platform: string;
    workdir: string;
    /** CWD-03：Workspace 实体绑定（可选；legacy 会话无此字段） */
    workspaceId?: string;
    sessionPrompt: string;
    skills: string[];
    hooks: string[];
    /** M2：启用的 commandSet 插件 id；旧数据缺省。 */
    commandSetPlugins?: string[];
    autoName: string;
    metadata?: Record<string, Record<string, unknown>>;
    context?: Record<string, Record<string, unknown>>;
    creationSnapshot?: SessionCreationSnapshot;
}
/**
 * owner 推断提示（ISSUE-01 v1 迁移，强度从强到弱）：
 * 1. 唯一 Agent 下的 periId（经 activeSessionByAgent → session.periId 反查）；
 * 2. workspace agent sheet 对 sessionId 的明确引用（activeSessionByAgent）；
 * 3. 唯一 Agent runtime 中的 source（sourcesByAgent，持久层迁移时通常为空，
 *    由恢复选择流程在运行时补充）。
 */
export interface OwnerHints {
    activeSessionByAgent: Record<string, string | undefined>;
    sourcesByAgent?: Record<string, readonly string[]>;
}
export type SessionHydrationResult = {
    kind: 'ready';
    sessions: Session[];
    turns?: Turn[];
} | {
    kind: 'needs-owner-resolution';
    sessions: Session[];
    unresolved: LegacySession[];
    turns?: Turn[];
} | {
    kind: 'corrupt';
    message: string;
};
interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
export declare function normalizeSessions(value: unknown, profiles: PersistedProfile[], hints?: OwnerHints): SessionHydrationResult;
export declare function serializeSessions(sessions: Array<PersistedSession | LegacySession>, turns?: Turn[]): string;
export declare function parseSessions(raw: string | null, profiles: PersistedProfile[], hints?: OwnerHints): SessionHydrationResult;
export declare function persistSessions(storage: StorageLike, sessions: PersistedSession[], turns?: Turn[]): boolean;
/**
 * CR-001：mutation 持久化保留 unresolved 现场——把尚未定 owner 的 legacy 会话
 * （原样、不补 agentId）与已解析会话并入同一 v2 envelope 写盘，避免用 resolved 子集
 * 覆盖存储而永久丢失未决数据。下次 loadSessions 重新推断/归类（幂等，无副作用）。
 */
export declare function persistSessionsWithUnresolved(storage: StorageLike, sessions: PersistedSession[], unresolved: readonly LegacySession[], turns?: Turn[]): boolean;
/**
 * 加载会话并迁移：
 * - ready：迁移写回 v2（含推断出的 agentId）；
 * - needs-owner-resolution：不写回——保留原始数据，等待恢复选择流程显式定 owner；
 * - corrupt：不写回，保留现场供诊断。
 */
export declare function loadSessions(storage: StorageLike, profiles: PersistedProfile[], hints?: OwnerHints): SessionHydrationResult;
export {};
