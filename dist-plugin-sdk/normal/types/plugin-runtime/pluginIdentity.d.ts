export interface PluginIdentity {
    readonly pluginId: string;
    readonly version: string;
    readonly packageInstanceId: string;
    readonly runtimeInstanceId: string;
    /** Migration alias; new code should use runtimeInstanceId. */
    readonly instanceId: string;
    /** Registry owner key; identical to runtimeInstanceId. */
    readonly key: string;
}
export declare function createPluginIdentity(pluginId: string, instanceId: string): PluginIdentity;
export declare function createPackagePluginIdentity(input: {
    pluginId: string;
    version: string;
    packageInstanceId: string;
    runtimeInstanceId: string;
}): PluginIdentity;
