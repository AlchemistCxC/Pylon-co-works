import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.js';
import type { FontContribution } from './fontContributionTypes.js';
export declare function fontContributionCssVariable(id: string): string;
export declare function validateFontContribution(contribution: FontContribution): FontContribution;
export declare class FontContributionRegistry {
    private readonly registry;
    register(owner: PluginIdentity, contribution: FontContribution): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<FontContribution>;
    subscribe(listener: () => void): () => void;
    getSnapshot(): RegistrySnapshot<FontContribution>;
    resolve(id: string): import("../registry/types.ts").RegistryEntry<FontContribution>;
}
