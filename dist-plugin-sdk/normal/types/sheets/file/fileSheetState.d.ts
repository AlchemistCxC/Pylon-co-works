/**
 * fileSheetState — FileSheet 分区状态纯域（W2-03）。
 *
 * 五分区（会话/文件/搜索/SCM/视图）+ targetSource（当前指向的会话 source）。
 * targetSource 是本地态：sheet 的 singletonKey = file:{初始 source}（同工作区复用），
 * 内部允许改指向；metadata 由组件经 workspaceStore patch（不串 source）。
 */
export declare const FILE_SHEET_SECTIONS: readonly ["sessions", "files", "search", "scm", "views"];
export type FileSheetSection = (typeof FILE_SHEET_SECTIONS)[number];
export interface FileSheetState {
    activeSection: string;
    targetSessionId: string | null;
}
export type FileSheetAction = {
    type: 'set-section';
    section: string;
} | {
    type: 'set-target-session';
    sessionId: string | null;
};
export declare function createFileSheetState(sessionId: string | null): FileSheetState;
export declare function resetFileSheetTransientState(): {
    truncated: boolean;
    instruction: string;
    fileContent: string;
};
export declare function fileSheetReducer(state: FileSheetState, action: FileSheetAction): FileSheetState;
export type FileTabMode = 'file' | 'diff';
export interface FileTabRecord {
    path: string;
    /** Open string namespace; first-party values are file.text and git.diff. */
    viewType?: string;
    /** @deprecated v2 compatibility input only. */
    mode?: FileTabMode;
    /** diff-mode tab 的 SCM 范围：true = staged（HEAD ↔ Index） */
    staged?: boolean;
    /** Optional 1-based reveal line, e.g. from workspace search. */
    line?: number;
}
export interface FileTabState {
    version: 2 | 3;
    tabs: FileTabRecord[];
    activeKey: string | null;
}
export declare const EMPTY_FILE_TAB_STATE: FileTabState;
/** tab 单例 key：mode 参与 identity——同路径 file/diff 不互相覆盖 */
export declare function fileTabViewType(tab: Pick<FileTabRecord, 'viewType' | 'mode'>): string;
export declare function fileTabKey(tab: Pick<FileTabRecord, 'path' | 'viewType' | 'mode'>): string;
export declare function serializeFileTabs(state: FileTabState): string;
/**
 * 宽容解析 + 版本迁移：
 * - v1 `openTabs: string[]` → 全部迁移为 file-mode tab；activeKey 取最后一条。
 * - v2 `{version:2,tabs:[...],activeKey}` → 规范化过滤。
 * - 损坏 JSON / 非 v1 数组 / 非 v2 对象 → 空（不清整个 persistence）。
 */
export declare function parseFileTabs(raw: string | undefined): FileTabState;
/** 由文件路径推断高亮语言（md 走渲染器；其余走 highlightCode scope） */
export declare function languageFromPath(path: string): string;
