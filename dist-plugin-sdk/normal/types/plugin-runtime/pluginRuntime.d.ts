import { type PluginIdentity } from './pluginIdentity.js';
import { type BuiltinPluginActivate, type BuiltinPluginActivationContext, type PluginDeactivateResult, type PluginInstance } from './pluginInstance.js';
import type { PluginHostServices } from './pluginHostServices.js';
import { type PluginContract, type PluginContractDiagnostic } from './pluginContractResolver.js';
import { type HotSwapMode, type PluginUpdateResult } from './shadowUpdate.js';
export interface BuiltinPluginDefinition {
    id: string;
    kind?: 'shell' | 'workspace' | 'feature' | 'hook' | 'renderer' | 'skin' | 'agent-adapter' | 'tool-provider' | 'service' | 'automation';
    firstParty?: boolean;
    criticality?: 'kernel-required' | 'product-required' | 'optional';
    dependencies?: Readonly<Record<string, string>>;
    optionalDependencies?: Readonly<Record<string, string>>;
    conflicts?: readonly string[];
    activationEvents?: readonly string[];
    version?: string;
    packageInstanceId?: string;
    runtimeInstanceId?: string;
    hotSwapMode?: HotSwapMode;
    drainTimeoutMs?: number;
    prepare?: (context: BuiltinPluginActivationContext) => unknown | Promise<unknown>;
    activate: BuiltinPluginActivate;
    suspend?: () => void | Promise<void>;
    resume?: () => void | Promise<void>;
    deactivate?: () => void | Promise<void>;
}
export type BuiltinPluginDefinitionFactory = (context: BuiltinPluginActivationContext) => BuiltinPluginDefinition;
export interface PluginSwitchDescriptor extends PluginUpdateResult {
    readonly committedAt: number;
}
export interface PluginRuntimeSnapshot {
    readonly revision: number;
    readonly active: readonly PluginIdentity[];
    readonly instances: readonly PluginRuntimeInstanceSnapshot[];
    readonly switches: readonly PluginSwitchDescriptor[];
}
export interface PluginRuntimeInstanceSnapshot {
    readonly identity: PluginIdentity;
    readonly status: PluginInstance['status'];
    readonly cleanup?: PluginDeactivateResult;
}
export interface PluginRuntimeOptions {
    host: PluginHostServices;
    requestSoftRemount?: () => void | Promise<void>;
}
export interface PluginUpdateOptions {
    identity?: PluginIdentity;
    commitActivePointer?: () => void | Promise<void>;
    requestSoftRemount?: () => void | Promise<void>;
}
export declare class PluginRestartRequiredError extends Error {
    readonly pluginId: string;
    readonly declaredMode: HotSwapMode;
    readonly adoptedMode: HotSwapMode;
    constructor(pluginId: string);
}
export declare class PluginDisableRejectedError extends Error {
    readonly code = "product_plugin_required";
    readonly pluginId: string;
    constructor(pluginId: string);
}
export declare class PluginContractBlockedError extends Error {
    readonly pluginId: string;
    readonly diagnostics: readonly PluginContractDiagnostic[];
    readonly code = "plugin_contract_blocked";
    constructor(pluginId: string, diagnostics: readonly PluginContractDiagnostic[]);
}
export declare class PluginRuntime {
    private readonly instances;
    private readonly definitions;
    private readonly knownDefinitions;
    private readonly listeners;
    private readonly updateQueues;
    private readonly switchRecords;
    private readonly options;
    private readonly host;
    private readonly createContext;
    private instanceSequence;
    private revision;
    private currentSnapshot;
    constructor(options: PluginRuntimeOptions);
    snapshot(): PluginRuntimeSnapshot;
    contractSnapshot(): readonly PluginContract[];
    subscribe(listener: () => void): () => void;
    private publishSnapshot;
    private assertInactive;
    activateBuiltin(definition: BuiltinPluginDefinition): Promise<PluginInstance>;
    activatePackage(definition: BuiltinPluginDefinition, identity?: PluginIdentity): Promise<PluginInstance>;
    /** 仅供明确要求同步完成的集成入口；Kernel bootstrap 不使用此路径。 */
    activateBuiltinSync(definition: BuiltinPluginDefinition): PluginInstance;
    update(definition: BuiltinPluginDefinition, options?: PluginUpdateOptions): Promise<PluginUpdateResult>;
    private performUpdate;
    deactivate(instanceKey: string): Promise<PluginDeactivateResult>;
    retryCleanup(instanceKey: string): Promise<PluginDeactivateResult>;
    disable(pluginId: string): Promise<PluginDeactivateResult>;
    enable(pluginId: string): Promise<PluginInstance>;
    reload(pluginId: string, mode?: HotSwapMode): Promise<PluginUpdateResult>;
    private withFreshRuntimeIdentity;
    private assertContractGraph;
    private toContract;
    private createIdentity;
}
