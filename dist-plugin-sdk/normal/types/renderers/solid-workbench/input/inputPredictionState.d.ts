export type PredictionSource = 'history' | 'llm';
export interface PredictionCandidate {
    readonly text: string;
    readonly source: PredictionSource;
}
/** Return the newest prior message that extends the current prefix. */
export declare function findHistoryCompletion(prefix: string, history: readonly string[]): string | null;
/** Keep provider output suitable for a single-line ghost suggestion. */
export declare function normalizePredictionText(value: unknown): string | null;
/** Merge durable (SQLite projected) and session-local history without duplicates. */
export declare function mergeHistory(...sources: readonly (readonly string[])[]): readonly string[];
export interface PredictionRateLimiter {
    canRequest(now?: number): boolean;
    markRequested(now?: number): void;
    reset(): void;
}
/** Claude-like low frequency gate: one speculative request per cooldown window. */
export declare function createPredictionRateLimiter(cooldownMs?: number, clock?: () => number): PredictionRateLimiter;
