import type { PluginIdentity } from '../pluginIdentity.js';
import type { RegisterOptions, RegistrySnapshot, AsyncDisposable } from '../registry/types.js';
import type { TitlebarContribution } from './titlebarTypes.js';
/** Reactive registry for application-shell titlebar contributions. */
export declare class TitlebarRegistry {
    private readonly registry;
    register(owner: PluginIdentity, contribution: TitlebarContribution, options: RegisterOptions): AsyncDisposable;
    subscribe(listener: () => void): () => void;
    getSnapshot(): RegistrySnapshot<TitlebarContribution>;
    beginTransaction(owner: PluginIdentity): import("../registry/types.ts").RegistryTransaction<TitlebarContribution>;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): import("../registry/types.ts").RegistryTransaction<TitlebarContribution>;
}
