import type { Session } from '../identityStore';
/** 内置 workspace 种子；动态 kind 的有效性以 Workspace Registry 为准。 */
export declare const SHEET_KINDS: readonly ["agent", "prism", "runtime", "file", "overview", "search", "history", "browser", "gateway"];
export type BuiltinSheetKind = typeof SHEET_KINDS[number];
export type SheetKind = string;
export type SheetId = string;
export interface SheetRecord {
    id: SheetId;
    kind: SheetKind;
    title: string;
    agentId?: string;
    singletonKey?: string;
    pinned?: boolean;
    createdAt: number;
    lastFocusedAt: number;
    metadata?: Record<string, string>;
    /** Workspace type definition 序列化后的插件状态；内存与持久化共用稳定 wire 形态。 */
    state?: unknown;
}
export interface SheetInput {
    id?: SheetId;
    kind: SheetKind | string;
    title: string;
    agentId?: string;
    singletonKey?: string;
    pinned?: boolean;
    metadata?: Record<string, string>;
    /** 传给 WorkspaceTypeDefinition.createInitialState 的插件输入。 */
    state?: unknown;
}
export interface SheetContext {
    openSheet: (input: SheetInput) => SheetId | null;
    focusSheet: (id: SheetId) => void;
    closeSheet: (id: SheetId) => void;
    activeSession: string | null;
    selectSession: (id: string | null) => void;
    openProfileEdit: () => void;
    openSessionSettings: (id: string) => void;
    sidebarCollapsed: boolean;
    rightInset: number;
    ccEditMode: boolean;
    /**
     * 当前 Sheet 是否位于活动主区。原生子 WebView 不受父 DOM 的 display:none
     * 影响，因此 Browser Sheet 用这个只读标记同步 show/hide；旧调用方省略时
     * 按活动态处理，保持第三方/测试上下文兼容。
     */
    isActive?: boolean;
    sessionSource: (sessionId: string | null) => string | null;
    sessionBySource: (source: string) => Session | undefined;
}
/** I09-A-FE-01：Sheet 左栏能力（方案 A，ISSUE-09.md）——'workspace'=布局层公共左栏 / 'sheet'=Sheet 内部自绘侧栏 / 'none'=无侧栏 */
export type SidebarMode = 'workspace' | 'sheet' | 'none';
export declare function isSheetKind(value: unknown): value is SheetKind;
