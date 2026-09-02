import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.js';
export type PluginServiceKind = 'search' | 'export' | 'event-projector' | 'session-state' | 'agent-detector' | 'agent-instance-sink' | 'tool-dictionary-sink';
export type PluginServiceResolutionErrorCode = 'plugin_service_unavailable' | 'plugin_service_ambiguous';
export declare class PluginServiceResolutionError extends Error {
    readonly code: PluginServiceResolutionErrorCode;
    readonly kind: PluginServiceKind;
    readonly serviceId: string | undefined;
    readonly matchCount: number;
    readonly matchingServiceIds: readonly string[];
    constructor(code: PluginServiceResolutionErrorCode, kind: PluginServiceKind, serviceId: string | undefined, matchCount: number, matchingServiceIds: readonly string[]);
}
export interface PluginServiceContribution<T = unknown> {
    readonly kind: PluginServiceKind;
    readonly id: string;
    readonly value: T;
}
export declare class PluginServiceRegistry {
    private readonly registry;
    register<T>(identity: PluginIdentity, contribution: PluginServiceContribution<T>): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<PluginServiceContribution>;
    getSnapshot(): RegistrySnapshot<PluginServiceContribution>;
    list<T>(kind: PluginServiceKind): T[];
    resolveRequired<T>(kind: PluginServiceKind, id?: string): T;
    private validate;
}
