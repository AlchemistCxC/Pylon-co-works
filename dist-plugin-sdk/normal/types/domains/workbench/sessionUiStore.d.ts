export type SessionUiKey = 'draft' | 'attachments' | 'input-error' | 'queued-messages' | 'search-open' | 'search-query' | 'search-index' | 'locate-target' | 'locate-error' | 'pendingMessageLocation' | 'task-tree-open' | 'input-history' | 'input-history-index' | 'message-expansion';
export interface SessionUiStore {
    get<T>(sessionId: string, key: SessionUiKey, fallback: T): T;
    set<T>(sessionId: string, key: SessionUiKey, value: T): void;
    update<T>(sessionId: string, key: SessionUiKey, fallback: T, updater: (previous: T) => T): T;
    subscribe(sessionId: string, key: SessionUiKey, listener: () => void): () => void;
    capture(sessionId: string): SessionUiScope;
    clear(sessionId: string): void;
    clearAll(): void;
    destroy(): void;
}
export interface SessionUiScope {
    get<T>(key: SessionUiKey, fallback: T): T;
    set<T>(key: SessionUiKey, value: T): void;
    update<T>(key: SessionUiKey, fallback: T, updater: (previous: T) => T): T;
    subscribe(key: SessionUiKey, listener: () => void): () => void;
    clear(): void;
}
export declare function createSessionUiStore(): SessionUiStore;
