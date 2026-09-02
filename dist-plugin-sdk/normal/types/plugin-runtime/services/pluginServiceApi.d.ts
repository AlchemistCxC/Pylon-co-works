import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
import type { RegistryTransaction } from '../registry/types.js';
import type { PluginServiceContribution, PluginServiceKind, PluginServiceRegistry } from './pluginServiceRegistry.js';
export interface PluginServiceApi {
    register<T>(kind: PluginServiceKind, id: string, value: T): void;
}
export declare function createPluginServiceApi(registry: PluginServiceRegistry, identity: PluginIdentity, scope: PluginScope, transaction?: RegistryTransaction<PluginServiceContribution>): PluginServiceApi;
