import { type CcLayoutV3 } from '../../ccLayoutState.js';
/**
 * 主题域 schema 版本（A4：独立于 PROFILE_SCHEMA_VERSION=4）。
 * 沿用共享编号的续号 5：保证存量数据（version 4）升级时触发 migrate。
 */
export declare const THEME_SCHEMA_VERSION = 7;
export type ThemeMigrationDefaults = {
    base: object;
    appliedPreset: Record<string, string>;
    custom: Record<string, boolean>;
    ccLayout: CcLayoutV3;
};
export declare function normalizeThemeMigrationState(persisted: unknown, defaults: ThemeMigrationDefaults): Record<string, unknown>;
/**
 * 完整迁移：键映射/legacy 删除 + defs 驱动归一化 + 历史字段特判 + ccHeight clamp。
 * store 侧 migrate 薄壳调用；defaults 传 store 的 DEFAULTS（避免域→store 循环）。
 */
export declare function themeDomainMigrate(persisted: unknown, defaults: ThemeMigrationDefaults, fromVersion?: number): Record<string, unknown>;
