/**
 * errorCenter — 运行错误聚合存储（模块级 + useSyncExternalStore）。
 *
 * reportRuntimeError 产生的错误统一收口为可回溯列表（带时间戳、可单个关闭/全部清除），
 * 替代"只显示最新一条"的单 banner。容量上限 50，超出丢弃最旧。
 */
import type { RuntimeErrorDetail } from './runtimeError';
export interface ErrorEntry extends RuntimeErrorDetail {
    id: number;
    at: number;
    /** 报告 8.3：同指纹（action+message）出现次数/首次/最后时间——去重聚合 */
    count: number;
    firstAt: number;
    lastAt: number;
}
export declare function addError(detail: RuntimeErrorDetail): void;
export declare function clearErrors(): void;
export declare function dismissError(id: number): void;
export declare function getErrors(): readonly ErrorEntry[];
export declare function useErrors(): readonly ErrorEntry[];
