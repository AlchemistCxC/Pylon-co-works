import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
import { HookRuntime } from './hookRuntime.js';
import type { HookDefinition, HookInvocationResult, HookName } from './hookTypes.js';
import type { HookRegistryTransaction } from './hookRegistry.js';
export interface PluginHookApi {
    register<TEvent>(hookName: HookName, definition: HookDefinition<TEvent>): ReturnType<HookRuntime['registry']['register']>;
    invoke<TEvent>(hookName: HookName, event: TEvent, enabledPluginIds?: readonly string[]): Promise<HookInvocationResult<TEvent>>;
}
export declare function createPluginHookApi(runtime: HookRuntime, identity: PluginIdentity, scope: PluginScope, transaction?: HookRegistryTransaction): PluginHookApi;
