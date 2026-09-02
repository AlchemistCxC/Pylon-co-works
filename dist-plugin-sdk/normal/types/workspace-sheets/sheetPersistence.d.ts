import { type SheetState } from './sheetState.js';
export declare const SHEET_SCHEMA_VERSION = 2;
export declare const SHEET_STORAGE_KEY = "pylon-workspace-sheets";
export interface SheetWorkspaceState {
    activeProfileId?: string;
    activeSessionId?: string;
}
export interface PersistedSheetState extends SheetState {
    agentStates: Record<string, SheetWorkspaceState>;
}
/** v2 layout 三字段（F2-B：布局状态从主题迁出，预设不覆盖） */
export interface SheetLayoutState {
    sidebarWidth: number;
    sidebarCollapsed: boolean;
    rightPanelCollapsed: boolean;
}
export declare const DEFAULT_SHEET_LAYOUT: SheetLayoutState;
interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
export declare const EMPTY_PERSISTED_SHEET_STATE: PersistedSheetState;
export interface SheetHydrateResult {
    state: PersistedSheetState;
    layout: SheetLayoutState;
    /** 输入为 v1（或缺失 layout）：true——调用方应立即 serialize 写回 v2 */
    migrated: boolean;
}
/**
 * 解析 v2 envelope；v1 输入走迁移（normalize sheets 清洗旧 kind，layout 取默认，
 * sidebarWidth 由调用方读旧主题一次性迁移）。损坏/未知 version 返回空状态（不抛错）。
 */
export declare function parseSheetStateV2(raw: string | null, agentIds?: readonly string[]): SheetHydrateResult;
/** 只输出 v2，不再生成 v1（细化路线 §4 步骤 6） */
export declare function serializeSheetStateV2(state: PersistedSheetState, layout: SheetLayoutState): string;
export declare function persistSheetStateV2(storage: StorageLike, state: PersistedSheetState, layout: SheetLayoutState): boolean;
export declare function loadSheetStateV2(storage: StorageLike, agentIds?: readonly string[]): SheetHydrateResult;
export declare function serializeSheetStateV1(state: PersistedSheetState): string;
export declare function parseSheetStateV1(raw: string | null, agentIds?: readonly string[]): PersistedSheetState;
export {};
