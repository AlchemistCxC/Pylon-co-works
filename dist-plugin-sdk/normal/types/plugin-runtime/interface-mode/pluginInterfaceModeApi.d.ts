import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
import type { RegistryTransaction } from '../registry/types.js';
import type { InterfaceModeRegistry } from './interfaceModeRegistry.js';
import type { InterfaceModeContribution } from './interfaceModeTypes.js';
export interface PluginInterfaceModeApi {
    registerMode(contribution: InterfaceModeContribution): void;
}
export declare function createPluginInterfaceModeApi(registry: InterfaceModeRegistry, identity: PluginIdentity, scope: PluginScope, transaction?: RegistryTransaction<InterfaceModeContribution>): PluginInterfaceModeApi;
