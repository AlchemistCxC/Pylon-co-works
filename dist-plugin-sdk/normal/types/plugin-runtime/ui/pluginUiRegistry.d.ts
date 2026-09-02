import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.js';
import { type PluginUiSurface } from './pluginUiTypes.js';
export declare class PluginUiRegistry {
    private readonly registry;
    register(owner: PluginIdentity, surface: PluginUiSurface): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<PluginUiSurface>;
    subscribe(listener: () => void): () => void;
    getSnapshot(): RegistrySnapshot<PluginUiSurface>;
    resolve(surfaceId: string): import("../registry/types.ts").RegistryEntry<PluginUiSurface>;
    private normalize;
}
