import type { SheetId, SheetRecord } from './sheetTypes.js';
export interface WorkspaceOpenInput {
    type: string;
    title?: string;
    state?: unknown;
    agentId?: string;
    singletonKey?: string;
    pinned?: boolean;
    metadata?: Record<string, string>;
}
export declare function openWorkspace(input: WorkspaceOpenInput): SheetId | null;
export declare function focusWorkspace(id: SheetId): boolean;
export declare function closeWorkspace(id: SheetId): Promise<boolean>;
export declare function closeOtherWorkspaces(id: SheetId): Promise<boolean>;
export declare function closeRightWorkspaces(id: SheetId): Promise<boolean>;
export declare function listOpenWorkspaces(): readonly SheetRecord[];
