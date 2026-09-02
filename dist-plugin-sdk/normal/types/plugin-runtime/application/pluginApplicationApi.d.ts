import type { PluginApplicationContribution, PluginApplicationHost, PluginApplicationRegistryTransaction } from './applicationHost.js';
import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
export interface PluginApplicationApi {
    register(contribution: PluginApplicationContribution): ReturnType<PluginApplicationHost['register']>;
}
export declare function createPluginApplicationApi(runtime: PluginApplicationHost, identity: PluginIdentity, scope: PluginScope, transaction?: PluginApplicationRegistryTransaction): PluginApplicationApi;
