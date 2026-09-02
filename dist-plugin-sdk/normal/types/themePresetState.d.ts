export interface PresetRouteState {
    appliedPreset: Record<string, string>;
    custom: Record<string, boolean>;
}
/**
 * 字段写入标记：只置 custom[zone]=true，不动 appliedPreset（基准保留，供"恢复原预设"）。
 * A1 模型：'custom' 不再是 appliedPreset 的枚举值，触碰状态由 custom 布尔独立表达。
 */
export declare function markZoneCustom<T extends PresetRouteState>(state: T, zone: string): Pick<PresetRouteState, 'custom'>;
