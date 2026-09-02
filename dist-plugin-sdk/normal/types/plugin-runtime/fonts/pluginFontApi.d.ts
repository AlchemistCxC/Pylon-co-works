import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
import type { RegistryTransaction } from '../registry/types.js';
import type { FontContribution } from './fontContributionTypes.js';
import type { FontContributionRegistry } from './fontContributionRegistry.js';
export interface PluginFontApi {
    registerFont(contribution: FontContribution): void;
}
export declare function createPluginFontApi(registry: FontContributionRegistry, identity: PluginIdentity, scope: PluginScope, transaction?: RegistryTransaction<FontContribution>): PluginFontApi;
