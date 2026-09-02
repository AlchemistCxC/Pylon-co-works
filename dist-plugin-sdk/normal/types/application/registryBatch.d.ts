export declare function notifyRegistryListener(listener: () => void): void;
/** Defers external-store notifications until all participating registries hold the new snapshot. */
export declare function runRegistryBatch<T>(operation: () => T): T;
