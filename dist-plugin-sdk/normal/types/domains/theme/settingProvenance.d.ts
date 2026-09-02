/**
 * settingProvenance — 主题字段写入溯源账本（D-trace）。
 *
 * 动机：主题字段存在 9 类写入方（用户编辑/zone 预设/全局预设/自定义预设/
 * 呈现风格 profile/界面模式重置/字段级恢复默认/cc 专用动作/持久化迁移），
 * 此前全部汇入同一 setZoneField 漏斗且互不可区分——"这个字段为什么是这个值"
 * 无法回答（自定义预设排查时的核心盲区）。
 *
 * 设计约束：
 * - 纯内存环形缓冲（不上 store、不持久化）：溯源是调试元数据，不是设置项
 *   （与 settingsChromeState 同一设计纪律：chrome/调试态不进 schema）。
 * - 记录在写入漏斗（store actions）处完成，reducer 保持纯函数。
 * - DEV 下暴露 window.__pylonSettingProvenance 供控制台追问。
 */
export type SettingWriteSource = 'user-edit' | 'field-reset' | 'zone-preset' | 'global-preset' | 'custom-preset' | 'presentation-profile' | 'theme-reset' | 'zone-reset';
export interface SettingWriteRecord {
    readonly key: string;
    readonly zone: string;
    readonly source: SettingWriteSource;
    readonly at: number;
}
/** 记录一次批量写入（一次 action 可能写多个字段）。at 由调用方注入以便测试。 */
export declare function recordSettingWrites(source: SettingWriteSource, zone: string, keys: readonly string[], at?: number): void;
/** 某字段最近一次写入的贡献者；从未被记录过返回 undefined。 */
export declare function lastSettingWriter(key: string): SettingWriteRecord | undefined;
/** 最近写入流水（新→旧），最多 limit 条。 */
export declare function recentSettingWrites(limit?: number): readonly SettingWriteRecord[];
/** 测试/重放水复位。 */
export declare function resetSettingProvenance(): void;
/** 溯源来源的展示文案（FieldRow title / 控制台输出共用）。 */
export declare const SETTING_WRITE_SOURCE_LABELS: Readonly<Record<SettingWriteSource, string>>;
declare global {
    interface Window {
        __pylonSettingProvenance?: {
            last: typeof lastSettingWriter;
            recent: typeof recentSettingWrites;
        };
    }
}
