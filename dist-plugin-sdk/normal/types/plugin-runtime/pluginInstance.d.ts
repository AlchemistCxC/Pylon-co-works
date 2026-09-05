import type { PluginIdentity } from './pluginIdentity.js';
import type { PluginCleanupError, PluginScopeDisposeResult } from './pluginScope.js';
import type { BuiltinPluginDefinition } from './pluginRuntime.js';
import { type BuiltinPluginActivationContext, type PluginActivationContextFactory } from './pluginActivationContext.js';
export type { BuiltinPluginActivationContext } from './pluginActivationContext.js';
export type PluginInstanceStatus = 'active' | 'deactivating' | 'inactive' | 'cleanup-failed';
export type BuiltinPluginActivate = (context: BuiltinPluginActivationContext, prepared?: unknown) => void | Promise<void>;
export interface PluginInstance {
    readonly identity: PluginIdentity;
    readonly scope: BuiltinPluginActivationContext['scope'];
    status: PluginInstanceStatus;
    deactivateHookComplete?: boolean;
    deactivateHookError?: PluginCleanupError;
    cleanup?: PluginDeactivateResult;
}
export interface PluginDeactivateResult {
    readonly complete: boolean;
    readonly alreadyInactive: boolean;
    readonly deactivateError?: PluginCleanupError;
    readonly scope: PluginScopeDisposeResult;
}
export declare function activateBuiltinPlugin(identity: PluginIdentity, activate: BuiltinPluginActivate, createContext: PluginActivationContextFactory, definition?: BuiltinPluginDefinition): Promise<PluginInstance>;
export declare function deactivatePluginInstance(instance: PluginInstance, deactivate?: () => void | Promise<void>): Promise<PluginDeactivateResult>;
