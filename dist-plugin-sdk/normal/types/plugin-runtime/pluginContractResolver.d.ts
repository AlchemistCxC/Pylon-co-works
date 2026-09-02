export interface PluginContract {
    readonly id: string;
    readonly version: string;
    readonly enabled: boolean;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly optionalDependencies?: Readonly<Record<string, string>>;
    readonly conflicts?: readonly string[];
    readonly activationEvents?: readonly string[];
}
export type PluginContractDiagnosticCode = 'dependency_missing' | 'dependency_blocked' | 'dependency_version_mismatch' | 'optional_dependency_version_mismatch' | 'dependency_cycle' | 'plugin_conflict' | 'waiting_activation';
export interface PluginContractDiagnostic {
    readonly pluginId: string;
    readonly code: PluginContractDiagnosticCode;
    readonly message: string;
    readonly blocking: boolean;
    readonly relatedPluginIds: readonly string[];
}
export interface PluginContractResolution {
    readonly eligibleIds: readonly string[];
    readonly blocked: readonly PluginContractDiagnostic[];
    readonly diagnostics: readonly PluginContractDiagnostic[];
}
export declare function satisfiesPluginVersionRange(version: string, range: string): boolean;
export declare function resolvePluginContracts(contracts: readonly PluginContract[], emittedEvents?: readonly string[]): PluginContractResolution;
