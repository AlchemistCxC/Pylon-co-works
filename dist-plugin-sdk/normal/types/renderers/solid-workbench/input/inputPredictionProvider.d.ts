import { type PredictionRateLimiter } from './inputPredictionState.js';
export interface InputPredictionRequest {
    readonly sessionId: string;
    readonly generation?: number;
    readonly draft: string;
    readonly history: readonly string[];
    /** Canonical bounded conversation transcript (assistant + user turns). */
    readonly messages?: readonly {
        role: 'user' | 'assistant';
        content: string;
    }[];
    readonly signal: AbortSignal;
}
export interface InputPredictionProvider {
    predict(request: InputPredictionRequest): Promise<string | null>;
}
export interface HttpPredictionProviderOptions {
    /** Local or remote endpoint that accepts a JSON prediction request. */
    readonly endpoint: string | URL;
    /** Injectable for tests; defaults to the browser/host fetch implementation. */
    readonly fetch?: typeof globalThis.fetch;
    readonly headers?: HeadersInit;
    /** Bound the durable history sent to the model (newest entries win). */
    readonly maxHistoryItems?: number;
    readonly maxHistoryChars?: number;
}
export interface PredictionHttpPayload {
    readonly sessionId: string;
    readonly generation?: number;
    readonly draft: string;
    readonly history: readonly string[];
    readonly messages?: readonly {
        role: 'user' | 'assistant';
        content: string;
    }[];
}
/**
 * Keep prediction context bounded even when the SQLite transcript is large.
 * Ordering is retained; the newest messages are preferred when truncating.
 */
export declare function boundPredictionHistory(history: readonly string[], options?: Pick<HttpPredictionProviderOptions, 'maxHistoryItems' | 'maxHistoryChars'>): readonly string[];
export declare function boundPredictionMessages(messages: readonly {
    role: 'user' | 'assistant';
    content: string;
}[], options?: Pick<HttpPredictionProviderOptions, 'maxHistoryItems' | 'maxHistoryChars'>): readonly {
    role: 'user' | 'assistant';
    content: string;
}[];
/**
 * Concrete provider seam for a local sidecar or remote prediction service.
 * The scheduler owns debounce, cancellation and cooldown; this adapter only
 * performs one bounded request and deliberately returns null for malformed or
 * non-2xx responses so the UI can fall back to history completion.
 */
export declare function createHttpPredictionProvider(options: HttpPredictionProviderOptions): InputPredictionProvider;
export interface PredictionScheduler {
    schedule(request: Omit<InputPredictionRequest, 'signal'>, onResult: (value: string | null) => void): void;
    cancel(): void;
    dispose(): void;
}
interface PredictionSchedulerOptions {
    debounceMs?: number;
    limiter?: PredictionRateLimiter;
    clock?: () => number;
}
/** Debounced, cancellable provider boundary. Results from stale session/generation are dropped. */
export declare function createPredictionScheduler(provider: InputPredictionProvider, options?: PredictionSchedulerOptions): PredictionScheduler;
export {};
