import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.js';
import type { InterfaceModeContribution } from './interfaceModeTypes.js';
export declare const INTERFACE_MODE_ID_PATTERN: RegExp;
export declare function validateInterfaceModeContribution(contribution: InterfaceModeContribution): InterfaceModeContribution;
export declare class InterfaceModeRegistry {
    private readonly registry;
    register(owner: PluginIdentity, contribution: InterfaceModeContribution): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<InterfaceModeContribution>;
    subscribe(listener: () => void): () => void;
    getSnapshot(): RegistrySnapshot<InterfaceModeContribution>;
    resolve(id: string): import("../registry/types.ts").RegistryEntry<InterfaceModeContribution>;
}
