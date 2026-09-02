/** Single read boundary for legacy identity/workspace layout keys. */
export declare const PERSISTENCE_KEY_OWNERS: Readonly<{
    readonly 'pylon-profiles': {
        readonly owner: "identity";
        readonly authority: "sqlite";
        readonly fallback: "localStorage";
        readonly version: 1;
    };
    readonly 'pylon-sessions': {
        readonly owner: "identity";
        readonly authority: "sqlite";
        readonly fallback: "localStorage";
        readonly version: 2;
    };
    readonly 'pylon-workspace-sheets': {
        readonly owner: "workspace";
        readonly authority: "localStorage";
        readonly fallback: "defaults";
        readonly version: 2;
    };
    readonly 'pylon-workspace-layout-v3': {
        readonly owner: "right-rail";
        readonly authority: "localStorage";
        readonly fallback: "legacy-layout";
        readonly version: 3;
    };
    readonly 'pylon-right-rail': {
        readonly owner: "right-rail";
        readonly authority: "legacy";
        readonly fallback: "defaults";
        readonly version: 1;
    };
    readonly 'pylon-theme': {
        readonly owner: "theme";
        readonly authority: "localStorage";
        readonly fallback: "defaults";
        readonly version: 4;
    };
}>;
/** Written after the application bootstrap has committed all legacy migrations. */
export declare const PERSISTENCE_MIGRATION_MARKER = "pylon-persistence-migration-v1";
export interface LegacyLayoutSnapshot {
    rightWidth?: number;
    leftWidth?: number;
    rightCollapsed?: boolean;
    leftCollapsed?: boolean;
}
/** Reads all legacy layout keys once, with deterministic precedence and field-level fallback. */
export declare function readLegacyLayoutSnapshot(storage?: Pick<Storage, 'getItem'> | null): LegacyLayoutSnapshot;
export declare function markLegacyMigrationComplete(storage?: Pick<Storage, 'setItem'> | null): void;
