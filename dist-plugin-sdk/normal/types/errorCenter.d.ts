/**
 * errorCenter — 运行错误聚合存储（模块级 + useSyncExternalStore）。
 *
 * reportRuntimeError 产生的错误统一收口为可回溯列表（带时间戳、可单个关闭/全部清除），
 * 替代"只显示最新一条"的单 banner。容量上限 50，超出丢弃最旧。
 */
import type { RuntimeErrorDetail, RuntimeErrorScope, RuntimeErrorVisibility } from './runtimeError';
export type ErrorEntryState = 'active' | 'resolved' | 'dismissed';
export type RuntimeErrorMatcher = {
    key?: string;
    action?: string;
    code?: string;
    source?: string;
    visibility?: RuntimeErrorVisibility;
    scope?: RuntimeErrorScope | string;
} | ((entry: ErrorEntry) => boolean);
export interface ErrorEntry extends RuntimeErrorDetail {
    id: number;
    /** Stable operation identity; display text is not used for resolution. */
    key: string;
    at: number;
    state: ErrorEntryState;
    resolvedAt?: number;
    dismissedAt?: number;
    /** 报告 8.3：同作用域/来源指纹的次数、首次与最后时间——去重聚合 */
    count: number;
    firstAt: number;
    lastAt: number;
}
export declare function errorEntryKey(detail: RuntimeErrorDetail): string;
export declare function addError(detail: RuntimeErrorDetail): void;
export declare function clearErrors(): void;
export declare function dismissError(id: number): void;
/** Mark matching notifications resolved without deleting their audit history. */
export declare function resolveRuntimeErrors(matcher: RuntimeErrorMatcher): void;
export declare function getErrors(): readonly ErrorEntry[];
export declare function getDiagnosticErrors(): readonly ErrorEntry[];
export declare function getErrorHistory(): readonly ErrorEntry[];
export declare function useErrors(): readonly ErrorEntry[];
export declare function useDiagnosticErrors(): readonly ErrorEntry[];
/** Runtime Sheet seam: inspect resolved/dismissed facts without reviving them. */
export declare function useErrorHistory(): readonly ErrorEntry[];
