/**
 * presetReducer — 预设路由的纯计算层（A0 抽出，A1 改模型）。
 *
 * 六个预设 action 的全部状态转换从 store.ts 迁到这里，store 只留
 * set(reducer(state, args)) 薄壳。依赖全部显式 .ts：node --experimental-strip-types
 * 可直接 import 本模块 → 预设语义可做确定性行为测试（save 的 id/now 由 shell 注入）。
 *
 * A1 模型：appliedPreset（基准名，无 'custom' 值）+ custom（触碰标记，事件驱动）+
 * PRESET_ZONES（5 zone，layout 无字段排除）。字段写入只标 custom，不动基准。
 */
/** 参与预设路由的 zone：layout 无字段（实证 zone:'layout'=0）排除 */
export declare const PRESET_ZONES: readonly ["global", "sidebar", "chat", "cc", "right"];
export type PresetZone = (typeof PRESET_ZONES)[number];
import type { CcLayoutV3 } from '../../ccLayoutState.js';
import { type CustomPreset } from '../../customPresets.js';
import type { ThemeSettings } from '../../store.js';
import type { PresetBundleV2 } from './presetBundle.js';
/** W2-15（F3-B）：全量主题 → 相对 DEFAULTS 的 delta（过滤与默认相等键；自定义预设存储用） */
export declare function toThemeDelta(theme: Record<string, unknown> | Partial<ThemeSettings>): Partial<ThemeSettings>;
/**
 * 预设路由所需的状态切片。字段类型与 ThemeState 兼容（结构可赋值）：
 * ThemeState → ThemePresetState 无需断言；patch 用 ThemePresetPatch（兼容 Partial<ThemeState>）。
 */
export interface ThemePresetState {
    appliedPreset: Record<string, string>;
    custom: Record<string, boolean>;
    customPresets: CustomPreset[];
    ccLayout: CcLayoutV3;
    ccHeight: number;
    ccBgHeight: number;
    inputMode: string;
    inputVariant: string;
    inputSubmitButtonMode: string;
    footerLayout: string;
    cliHintMode: string;
    ccHidden: string[];
    ccStyle: string;
    cliOverflowMode: string;
}
/** reducer 返回的 patch：主题字段 + 预设路由/cc 同步字段（可赋值给 Partial<ThemeState>） */
export type ThemePresetPatch = Partial<ThemeSettings> & Partial<Pick<ThemePresetState, 'appliedPreset' | 'custom' | 'customPresets' | 'ccLayout' | 'ccHeight' | 'ccBgHeight'>>;
/**
 * inputVariant↔inputMode 联动不变量（MEDIUM 5 收敛）：inputMode==='cli' ⟺ inputVariant==='cli'。
 * 单一真值：setZoneFieldReducer 漏斗 / migration 派生 / UI 层 chips sync 全部满足同一关系。
 */
export declare function resolveInputMode(inputVariant: string): 'cli' | 'default';
export declare function applyInputVariantInvariant(partial: Record<string, unknown>, current: {
    inputMode: string;
    inputVariant: string;
}): Record<string, unknown>;
/**
 * 单字段写入（D1 校验漏斗）：写入字段 + 该 zone 标记 custom（基准不动）。
 * 漏斗内聚三条布局不变量（此前只在 setCcHeight/预设 action/migrate 各自维护）：
 * - inputVariant↔inputMode 联动（cli ⟺ cli，否则 inputMode=default）
 * - ccHeight clamp（≥ resolveCcMinHeight 布局约束真值）
 * - ccBgHeight ≥ ccHeight（背景不短于容器）
 */
export declare function setZoneFieldReducer(state: ThemePresetState, zone: string, partial: Record<string, unknown>): ThemePresetPatch;
/** 应用 zone 预设：写字段 + 记基准名 + 清该 zone custom（A2：不再手写 global 标记，全局由 deriveGlobalStatus 派生） */
export declare function applyZonePresetReducer(state: ThemePresetState, zone: string, presetName: string, presetTheme: Partial<ThemeSettings>): ThemePresetPatch;
/** 切换全局预设：全 PRESET_ZONES 记名 + 全 custom 清零 + 恢复规范排布 */
export declare function setGlobalPresetReducer(name: string, theme: Partial<ThemeSettings>): ThemePresetPatch;
export interface SavePresetCommand {
    /** 已存在的预设 id（更新场景由调用方传入） */
    id: string;
    name: string;
    /** 由 store shell 注入，reducer 保持确定性 */
    now: number;
    /** Optional v2 owner contributions captured by the shell. */
    bundle?: PresetBundleV2;
}
/** 保存自定义预设：命名强制；捕获当前全主题；upsert；返回 savedId */
export declare function saveCustomPresetReducer(state: ThemePresetState, command: SavePresetCommand): {
    patch: ThemePresetPatch;
    savedId: string;
};
/**
 * 应用自定义预设：防御性归一化 + 全 PRESET_ZONES 记 id + 全 custom 清零。
 * theme 显式传入时直接消费（bundle 驱动，免疫 id 漂移）；否则按 id 回查
 * customPresets（旧路径）。两者都落空返回 null（调用方必须可见地报告，
 * 不得静默吞掉）。
 */
export declare function applyCustomPresetReducer(state: ThemePresetState, id: string, explicitTheme?: Record<string, unknown>): ThemePresetPatch | null;
/**
 * 全局预设状态派生（A2，覆盖规则 1/2 的单一真值）：
 * - 全空且无触碰 → ''
 * - 任一 zone 触碰（custom=true）→ 'custom'（规则 1：改字段 → 全局变 custom）
 * - 所有非空基准一致且无空 zone → 跟随该基准（空 zone 视为偏离 → custom，规则 2）
 */
export declare function deriveGlobalStatus(state: Pick<ThemePresetState, 'appliedPreset' | 'custom'>): string;
/** 单 zone 状态派生：基准名 + 是否自定义 */
export declare function deriveZoneStatus(state: Pick<ThemePresetState, 'appliedPreset' | 'custom'>, zone: PresetZone): {
    appliedName: string;
    isCustom: boolean;
};
/**
 * 删除自定义预设：引用该 id 的 zone 失去基准（appliedPreset=''）且 custom=true——
 * 字段保留已删预设的值 = 失去基准的自定义快照（不是默认态）。
 */
export declare function removeCustomPresetReducer(state: ThemePresetState, id: string): ThemePresetPatch;
