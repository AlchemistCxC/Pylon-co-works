import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
import type { RegisterOptions, AsyncDisposable, RegistryTransaction } from '../registry/types.js';
import type { TitlebarContribution } from './titlebarTypes.js';
import type { TitlebarRegistry } from './titlebarRegistry.js';
export interface PluginTitlebarApi {
    register(contribution: TitlebarContribution, options: Omit<RegisterOptions, 'contributionId'> & {
        contributionId?: string;
    }): AsyncDisposable;
}
export declare function createPluginTitlebarApi(registry: TitlebarRegistry, identity: PluginIdentity, _scope: PluginScope, transaction?: RegistryTransaction<TitlebarContribution>): PluginTitlebarApi;
