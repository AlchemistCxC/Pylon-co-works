import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
import type { RegistryTransaction } from '../registry/types.js';
import type { FileWorkbenchRegistry } from './fileWorkbenchRegistry.js';
import type { FileWorkbenchContribution } from './fileWorkbenchTypes.js';
export interface PluginFileWorkbenchApi {
    register(contribution: FileWorkbenchContribution): void;
}
export declare function createPluginFileWorkbenchApi(registry: FileWorkbenchRegistry, identity: PluginIdentity, scope: PluginScope, transaction?: RegistryTransaction<FileWorkbenchContribution>): PluginFileWorkbenchApi;
