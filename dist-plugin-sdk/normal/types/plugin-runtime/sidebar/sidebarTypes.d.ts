import type { RegistryEntry } from '../registry/types.js';
import type { WorkspaceSession } from '../../domains/session/workspaceSession.js';
import type { Workspace } from '../../workspaceEntities.js';
export type AgentSidebarMode = 'work' | 'chat';
export interface AgentSidebarContributionContext {
    readonly mode: AgentSidebarMode;
    readonly activeAgentId: string;
    readonly activeSessionId: string | null;
    readonly query: string;
}
export interface AgentSidebarContributionProps {
    readonly activeAgentId: string;
    readonly query: string;
    readonly activeSessionId: string | null;
    readonly sessions: readonly WorkspaceSession[];
    readonly workspaces: readonly Workspace[];
    readonly liveGeneratingSources: readonly string[];
    readonly onSelectSession: (id: string) => void;
    readonly onDeleteSession: (id: string) => Promise<void>;
    readonly onExportSession?: (id: string) => Promise<void>;
    readonly onArchiveSession?: (id: string) => Promise<void> | void;
    readonly onOpenSessionSettings: (id: string) => void;
    readonly onRenameSession: (id: string, name: string) => void;
    readonly onCreateChatSession: () => void;
    readonly onCreateWorkspace: (name: string, rootPath: string) => Promise<void>;
    readonly onCreateWorkspaceSession: (workspaceId: string) => void;
}
interface AgentSidebarContributionBase {
    readonly id: string;
    readonly mode: AgentSidebarMode;
    readonly label: string;
    readonly order?: number;
    readonly when?: (context: AgentSidebarContributionContext) => boolean;
}
export interface FirstPartyAgentSidebarContribution extends AgentSidebarContributionBase {
    readonly renderKind: 'first-party-react';
    /** Opaque at the runtime boundary; the React host narrows it before rendering. */
    readonly component: unknown;
}
export interface IsolatedAgentSidebarContribution extends AgentSidebarContributionBase {
    readonly renderKind: 'isolated-surface';
    readonly surfaceId: string;
}
export type AgentSidebarContribution = FirstPartyAgentSidebarContribution | IsolatedAgentSidebarContribution;
export type AgentSidebarRegistryEntry = RegistryEntry<AgentSidebarContribution>;
export {};
