import type { WorkspaceSession } from '../session/workspaceSession.js';
/** Stable FileSheet identity. It never depends on the currently active Agent/runtime. */
export interface WorkspaceTarget {
    sessionId: string;
    agentId: string;
    source: string;
    workspaceId?: string;
    legacyWorkdir?: string;
}
export type WorkspaceTargetWire = WorkspaceTarget;
export declare function workspaceTargetFromSession(session: WorkspaceSession | undefined): WorkspaceTarget | null;
export declare function workspaceTargetKey(target: WorkspaceTarget | null): string | null;
