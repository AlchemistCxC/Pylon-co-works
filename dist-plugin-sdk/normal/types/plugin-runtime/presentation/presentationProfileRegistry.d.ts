import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.js';
import type { PresentationProfileContribution } from './presentationProfileTypes.js';
export declare function validatePresentationProfile(contribution: PresentationProfileContribution): PresentationProfileContribution;
export declare class PresentationProfileRegistry {
    private readonly registry;
    register(owner: PluginIdentity, contribution: PresentationProfileContribution): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<PresentationProfileContribution>;
    subscribe(listener: () => void): () => void;
    getSnapshot(): RegistrySnapshot<PresentationProfileContribution>;
    resolve(id: string): import("../registry/types.ts").RegistryEntry<PresentationProfileContribution>;
}
