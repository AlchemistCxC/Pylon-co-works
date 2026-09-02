import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable } from '../registry/types.js';
export interface PluginEventEnvelope<T = unknown> {
    readonly event: string;
    readonly payload: T;
    readonly publishedAt: number;
    readonly publisher?: PluginIdentity;
}
export type PluginEventListener<T = unknown> = (event: PluginEventEnvelope<T>) => void | Promise<void>;
export interface EventBusSnapshot {
    readonly revision: number;
    readonly subscriptions: readonly {
        event: string;
        ownerPluginId: string;
        ownerRuntimeInstanceId: string;
        subscriptionId: string;
    }[];
}
export declare class PluginEventBus {
    private readonly subscriptions;
    private readonly listeners;
    private revision;
    private snapshot;
    subscribe<T>(owner: PluginIdentity, event: string, subscriptionId: string, listener: PluginEventListener<T>): AsyncDisposable;
    publish<T>(event: string, payload: T, publisher?: PluginIdentity): Promise<void>;
    subscribeSnapshot(listener: () => void): () => void;
    getSnapshot(): EventBusSnapshot;
    clear(): void;
    private publishSnapshot;
}
