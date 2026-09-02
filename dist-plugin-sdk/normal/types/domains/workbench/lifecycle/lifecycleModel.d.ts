/**
 * C13：生命周期 / 错误 / 自愈统一语义模型（纯 domain，无 IO/store/framework import）。
 *
 * - NormalizedError 是错误一等契约：userSummary / technicalMessage / code /
 *   recoverability / cause chain；UI 只读结构化字段，不得解析字符串决定动作
 *   （C13 完成定义）。
 * - lifecycle 事件收敛为 LifecycleState：retry/compact/rewind/suspended 是当前态，
 *   history 保留全部已发生事实——恢复成功不删除历史，只更新状态关联（K07 精神：
 *   状态名称与真实投影一致）。
 */
export declare const LIFECYCLE_PHASES: readonly ["retry", "compact", "rewind", "suspended", "recovered"];
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];
export type Recoverability = 'retry' | 'fallback' | 'reload-plugin' | 'reimport' | 'none';
export type ErrorPhase = 'resolve' | 'prepare' | 'mount' | 'update' | 'switch' | 'action' | 'destroy' | 'settings-migrate';
export interface NormalizedError {
    /** 面向用户的摘要（可理解） */
    readonly userSummary: string;
    /** 技术细节（可审计；默认折叠） */
    readonly technicalMessage?: string;
    readonly code?: string;
    readonly provider?: string;
    readonly sessionId?: string;
    readonly eventId?: string;
    readonly renderKind?: string;
    readonly rendererId?: string;
    readonly rendererSuiteId?: string;
    readonly rendererSlotId?: string;
    readonly pluginId?: string;
    readonly runtimeInstanceId?: string;
    readonly phase?: ErrorPhase;
    readonly recoverability: Recoverability;
    /** cause chain：深度受控的嵌套原因 */
    readonly cause?: NormalizedError;
    /** provider 扩展字段；不把原始 provider 对象直接暴露给 renderer */
    readonly metadata?: Readonly<Record<string, unknown>>;
}
/**
 * unknown → NormalizedError。字符串输入按 userSummary=technicalMessage 收窄；
 * 嵌套 cause 深度截断到 MAX_CAUSE_DEPTH，超出部分以 causeTruncated metadata 留痕。
 */
export declare function normalizeNormalizedError(raw: unknown, depth?: number): NormalizedError | undefined;
export interface RetryState {
    readonly attempt: number;
    readonly maxAttempts?: number;
    readonly delayMs?: number;
    readonly error?: NormalizedError;
}
export interface CompactState {
    readonly phase: 'started' | 'completed';
    readonly strategy?: string;
    readonly trigger?: string;
    readonly tokensBefore?: number;
    readonly tokensAfter?: number;
    readonly summary?: string;
}
export interface RewindState {
    readonly phase: 'preview' | 'completed';
    readonly files?: readonly JsonRecord[];
    readonly messages?: readonly JsonRecord[];
    readonly summary?: string;
}
export interface RecoveryInfo {
    readonly source: 'canonical' | 'agent-import';
    readonly importedEvents?: number;
}
type JsonRecord = Record<string, unknown>;
export interface LifecycleHistoryItem {
    readonly kind: LifecyclePhase;
    /** compact/rewind 阶段（started/completed、preview/completed） */
    readonly phase?: 'started' | 'completed' | 'preview';
    readonly attempt?: number;
    readonly maxAttempts?: number;
    readonly delayMs?: number;
    readonly error?: NormalizedError;
    readonly strategy?: string;
    readonly trigger?: string;
    readonly tokensBefore?: number;
    readonly tokensAfter?: number;
    readonly files?: readonly JsonRecord[];
    readonly messages?: readonly JsonRecord[];
    readonly summary?: string;
    readonly source?: RecoveryInfo['source'];
    readonly importedEvents?: number;
    readonly reason?: string;
}
export interface LifecycleState {
    readonly retry?: RetryState;
    readonly compact?: CompactState;
    readonly rewind?: RewindState;
    readonly suspended?: {
        readonly reason?: string;
    };
    readonly lastRecovery?: RecoveryInfo;
    readonly history: readonly LifecycleHistoryItem[];
}
export declare function createEmptyLifecycleState(): LifecycleState;
interface LifecycleEventInput {
    readonly type: string;
    readonly attempt?: unknown;
    readonly maxAttempts?: unknown;
    readonly delayMs?: unknown;
    readonly error?: unknown;
    readonly strategy?: unknown;
    readonly trigger?: unknown;
    readonly tokensBefore?: unknown;
    readonly tokensAfter?: unknown;
    readonly files?: unknown;
    readonly messages?: unknown;
    readonly summary?: unknown;
    readonly reason?: unknown;
    readonly source?: unknown;
    readonly importedEvents?: unknown;
}
/** lifecycle 事件 reducer：终态收敛当前态、全部事实进 history（只追加不删除）。 */
export declare function applyLifecycleEvent(state: LifecycleState, event: LifecycleEventInput): LifecycleState;
/** 当前活动错误：retry 在途时其 error 为活动错误；恢复后清空（历史保留） */
export declare function selectActiveErrors(state: LifecycleState): readonly NormalizedError[];
/** React generic fallback 文本行：全部历史可读 */
export declare function readableLifecycleLines(history: readonly LifecycleHistoryItem[]): readonly string[];
/** 单行摘要：无活动状态时空串。suspended 优先于 retry 展示（暂停即重试链挂起） */
export declare function plainLifecycleSummary(state: LifecycleState): string;
/** Strict renderer boundary guards. Normalization happens before these functions. */
export declare function isValidLifecycleStateInput(input: unknown): input is LifecycleState;
export declare function isValidNormalizedErrorInput(input: unknown, depth?: number): input is NormalizedError;
export declare function isValidSystemNoticeInput(input: unknown): input is {
    readonly code: string;
    readonly message: string;
    readonly eventId: string;
    readonly sequence: number;
    readonly level: 'info' | 'warning' | 'error';
    readonly data?: unknown;
};
export {};
