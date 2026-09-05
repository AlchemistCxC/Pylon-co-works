export interface SettingsTarget {
    readonly namespace: 'theme' | 'kind' | 'slot' | 'suite' | 'plugin-page' | 'context-panel';
    readonly ownerId: string;
    readonly ownerPluginId?: string;
    readonly fieldKey: string;
}
export declare function validateSettingsTarget(target: SettingsTarget): SettingsTarget;
/** Structured targets are canonical; dotted strings are legacy-only and fail closed when ambiguous. */
export declare function stringifySettingsTarget(target: SettingsTarget): string;
export declare function parseSettingsTarget(value: string): SettingsTarget | undefined;
