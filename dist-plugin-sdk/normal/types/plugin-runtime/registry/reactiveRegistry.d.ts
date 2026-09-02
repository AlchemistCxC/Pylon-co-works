import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable, ReactiveRegistry, RegisterOptions, RegistrySnapshot, RegistryTransaction } from './types.js';
export declare class ReactiveRegistryStore<T> implements ReactiveRegistry<T> {
    private readonly entries;
    private readonly listeners;
    private revision;
    private snapshot;
    register(owner: PluginIdentity, value: T, options: RegisterOptions): AsyncDisposable;
    subscribe(listener: () => void): () => void;
    getSnapshot(): RegistrySnapshot<T>;
    beginTransaction(owner: PluginIdentity): RegistryTransaction<T>;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<T>;
    private createTransaction;
    private commitEntries;
    private publish;
}
