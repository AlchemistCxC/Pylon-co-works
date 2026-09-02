import { type Workspace } from './workspaceEntities';
interface WorkspaceEntityStore {
    workspaces: Workspace[];
    hydrated: boolean;
    hydrate: () => Promise<void>;
    byId: (id: string) => Workspace | undefined;
    createWorkspace: (name: string, rootPath: string) => Promise<Workspace>;
    updateWorkspace: (id: string, patch: {
        name?: string;
        rootPath?: string;
        skills?: string[];
        mcpServerIds?: string[];
        hookPluginIds?: string[];
    }) => Promise<Workspace>;
    deleteWorkspace: (id: string) => Promise<void>;
}
export declare const useWorkspaceEntityStore: import("zustand").UseBoundStore<import("zustand").StoreApi<WorkspaceEntityStore>>;
export {};
