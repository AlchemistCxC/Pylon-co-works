/**
 * workspaceSearchContracts — 工作区搜索契约（W2-06 桩化）。
 *
 * workspace_search 待产品侧后端命令（后端 DTO 未定——contract 以实际返回为准再施工）。
 * 桩化先行：前端只消费正式命令（不以前端遍历文件冒充搜索），命令不可用 → 明确「待后端」
 * 阻塞态；宽松 normalize 假设形状（path/line/lineText），后端契约到位后对齐字段名。
 */
export interface WorkspaceSearchResult {
    path: string;
    line: number;
    lineText: string;
}
export declare function normalizeWorkspaceSearchResults(raw: unknown): WorkspaceSearchResult[];
export type WorkspaceSearchSaveStatus = {
    kind: 'idle';
} | {
    kind: 'searching';
} | {
    kind: 'blocked';
} | {
    kind: 'error';
    message: string;
};
/** invoke 错误分类：命令不存在 → blocked（待后端）；其余 → error */
export declare function classifyWorkspaceSearchError(error: unknown): Exclude<WorkspaceSearchSaveStatus, {
    kind: 'idle';
} | {
    kind: 'searching';
}>;
