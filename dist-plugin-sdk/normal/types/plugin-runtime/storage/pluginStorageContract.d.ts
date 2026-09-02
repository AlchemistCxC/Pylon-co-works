/** Runtime-neutral public storage contract shared by host and SDK bundles. */
export declare const PLUGIN_STORAGE_BUDGET_BYTES: number;
export declare class PluginStorageError extends Error {
    readonly field: string;
    readonly code = "plugin_storage_error";
    constructor(field: string, message: string);
}
