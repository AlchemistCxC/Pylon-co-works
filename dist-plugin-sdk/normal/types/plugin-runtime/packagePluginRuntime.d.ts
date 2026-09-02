import type { PluginPackageClient, PluginPackageDescriptor } from '../infrastructure/plugins/pluginPackageClient.js';
import type { BuiltinPluginActivationContext } from './pluginActivationContext.js';
import type { PluginRuntime } from './pluginRuntime.js';
import type { PluginUpdateResult } from './shadowUpdate.js';
export interface PackagePluginModule {
    prepare?: (context: BuiltinPluginActivationContext) => unknown | Promise<unknown>;
    activate: (context: BuiltinPluginActivationContext, prepared?: unknown) => void | Promise<void>;
    suspend?: () => void | Promise<void>;
    resume?: () => void | Promise<void>;
    deactivate?: () => void | Promise<void>;
}
export interface PackagePluginRuntimeOptions {
    runtime: PluginRuntime;
    packages: PluginPackageClient;
    importEntry?: (url: string) => Promise<unknown>;
    createRuntimeId?: (packageInstanceId: string) => string;
}
export interface PackagePluginUpdateResult extends PluginUpdateResult {
    readonly operationId: string;
    readonly package: PluginPackageDescriptor;
}
export interface PackagePluginActivationResult {
    readonly operationId: string;
    readonly package: PluginPackageDescriptor;
    readonly runtimeInstanceId: string;
}
export declare class PackagePluginRuntimeService {
    private readonly runtime;
    private readonly packages;
    private readonly importEntry;
    private readonly createRuntimeId;
    private runtimeSequence;
    constructor(options: PackagePluginRuntimeOptions);
    activateFromDirectory(sourcePath: string, expectedId: string): Promise<PackagePluginActivationResult>;
    activateInstalled(descriptor: PluginPackageDescriptor): Promise<PackagePluginActivationResult>;
    updateFromDirectory(sourcePath: string, expectedId: string): Promise<PackagePluginUpdateResult>;
    private loadDefinition;
}
