import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.js';
import type { FileWorkbenchContribution } from './fileWorkbenchTypes.js';
export declare class FileWorkbenchRegistry {
    private readonly registry;
    register(owner: PluginIdentity, value: FileWorkbenchContribution): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<FileWorkbenchContribution>;
    subscribe(listener: () => void): () => void;
    getSnapshot(): RegistrySnapshot<FileWorkbenchContribution>;
}
