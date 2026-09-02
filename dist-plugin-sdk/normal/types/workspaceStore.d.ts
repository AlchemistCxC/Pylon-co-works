import { createSheetState } from './workspace-sheets/sheetState.js';
import { type SheetWorkspaceState } from './workspace-sheets/sheetPersistence.js';
import { type TouchedFile } from './infrastructure/acp/touchedFiles.js';
import type { SheetInput, SheetId } from './workspace-sheets/sheetTypes.js';
import type { AgentContext, AgentContextKey } from './agentContext.js';
/** I01-W3：touchedFiles 刷新版本戳 key——context key + normalized path 二元（禁止冒号 split）。 */
export declare function touchedFileVersionKey(context: AgentContext, path: string): string;
interface WorkspaceStoreState {
    workspaceSheets: ReturnType<typeof createSheetState>;
    sheetAgentStates: Record<string, SheetWorkspaceState>;
    sidebarWidth: number;
    sidebarCollapsed: boolean;
    rightPanelCollapsed: boolean;
    showPet: boolean;
    /** FE-AUD-001：最近一次工作区写盘失败的可见状态（null = 无失败） */
    lastPersistError: string | null;
    hydrateWorkspaceSheets: (agentIds?: readonly string[]) => void;
    openSheet: (sheet: SheetInput) => SheetId | null;
    focusSheet: (id: SheetId) => void;
    toggleSheetPin: (id: SheetId) => void;
    closeSheet: (id: SheetId) => void;
    closeOtherSheets: (id: SheetId) => void;
    closeRightSheets: (id: SheetId) => void;
    reopenSheet: () => SheetId | null;
    setSheetAgentState: (agentId: string, partial: Partial<SheetWorkspaceState>) => void;
    /** W2-04：原子合并 sheet metadata（openTabs/activeFile 等）并持久化 */
    patchSheetMetadata: (id: SheetId, partial: Record<string, string>) => void;
    /** Workspace definition state 经 codec 合并后持久化。 */
    patchSheetState: (id: SheetId, partial: Record<string, unknown>) => void;
    /** W2-09 + I01-W3：工具改动文件（会话级 50 LRU，不持久化）+ 刷新版本戳；
     *  按 AgentContextKey（agentId+source）隔离——双 Agent 同名 source 文件状态不共享 */
    touchedFiles: Record<AgentContextKey, TouchedFile[]>;
    touchVersions: Record<string, number>;
    recordTouchedFile: (context: AgentContext, file: Omit<TouchedFile, 'source'>) => void;
    /** FE-AUD-005：agents 到达后仅 prune 无效 agent sheet（不重复全量 hydrate） */
    pruneAgentSheets: (agentIds: readonly string[]) => void;
    patchSheetAgentState: (agentId: string, partial: Partial<SheetWorkspaceState>) => void;
    patchSheetAgentStates: (agentStates: Record<string, SheetWorkspaceState>) => void;
    setSidebarWidth: (width: number) => void;
    setSidebarCollapsed: (collapsed: boolean) => void;
    setRightPanelCollapsed: (collapsed: boolean) => void;
    setShowPet: (show: boolean) => void;
}
export declare const useWorkspaceStore: import("zustand").UseBoundStore<import("zustand").StoreApi<WorkspaceStoreState>>;
export {};
