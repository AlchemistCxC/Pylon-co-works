import type { Session, SessionConfig } from '../../store';
import type { AvailableCommand } from '../../infrastructure/acp/chatContracts';
import type { AgentContext, AgentContextKey } from '../../agentContext.js';
export interface SessionLiveStats {
    tokensUsed: number;
    tokensMax: number;
    cacheReadTokens: number;
    commands: AvailableCommand[];
}
export declare function emptySessionLiveStats(): SessionLiveStats;
export declare function updateSessionLiveStats(state: Record<AgentContextKey, SessionLiveStats>, context: AgentContext, partial: Partial<SessionLiveStats>): Record<AgentContextKey, SessionLiveStats>;
interface ClearSessionSourceStateOptions {
    context: AgentContext;
    sessionLiveStats: Record<AgentContextKey, SessionLiveStats>;
    sessionModes: Record<AgentContextKey, string>;
    sessionConfig: Record<AgentContextKey, SessionConfig>;
    generatingSources: string[];
}
export declare function clearSessionSourceState({ context, sessionLiveStats, sessionModes, sessionConfig, generatingSources, }: ClearSessionSourceStateOptions): {
    sessionLiveStats: Record<AgentContextKey, SessionLiveStats>;
    sessionModes: Record<AgentContextKey, string>;
    sessionConfig: Record<AgentContextKey, SessionConfig>;
    generatingSources: string[];
};
interface BuildSendMessagePayloadOptions {
    session: Session;
    content: string;
    persona: string;
    attachments: string[];
}
export declare function buildSendMessagePayload({ session, content, persona, attachments }: BuildSendMessagePayloadOptions): {
    agentId: string;
    profileId: string;
    source: string;
    content: string;
    persona: string;
    sessionPrompt: string;
    attachments: string[];
};
export {};
