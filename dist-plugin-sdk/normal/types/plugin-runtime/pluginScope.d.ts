export type PluginResourceDisposable = (() => void | Promise<void>) | {
    dispose: () => void | Promise<void>;
};
export interface PluginResourceMetadata {
    readonly resourceId?: string;
    readonly label?: string;
}
export interface PluginCleanupError {
    readonly resourceId: string;
    readonly message: string;
}
export interface PluginScopeDisposeResult {
    readonly disposed: number;
    readonly remaining: number;
    readonly errors: readonly PluginCleanupError[];
}
export declare class PluginScope {
    readonly ownerKey: string;
    private resources;
    private closing;
    private disposed;
    private resourceSequence;
    private disposal;
    constructor(ownerKey: string);
    get isDisposed(): boolean;
    get size(): number;
    add<T extends PluginResourceDisposable>(resource: T, metadata?: PluginResourceMetadata): T;
    listen(target: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): () => void;
    setTimeout(handler: TimerHandler, timeout?: number, ...args: unknown[]): ReturnType<typeof setTimeout>;
    setInterval(handler: TimerHandler, timeout?: number, ...args: unknown[]): ReturnType<typeof setInterval>;
    createAbortController(): AbortController;
    disposeNow(): Promise<PluginScopeDisposeResult>;
    dispose(): Promise<PluginScopeDisposeResult>;
    private performDispose;
}
