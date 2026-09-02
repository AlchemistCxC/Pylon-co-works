export type AgentConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'crashed' | 'error' | 'unknown' | 'inactive';
export interface AgentInfo {
    id: string;
    name: string;
    transport?: string;
    cwd?: string;
}
export interface SessionBindingSnapshot {
    agentId: string;
    source: string;
    health: 'attached' | 'probing' | 'detached';
    generation: number;
    fromGeneration?: number;
    reason?: string;
    retryable: boolean;
}
export interface AgentStatus {
    agent: string;
    agentId?: string;
    status: AgentConnectionStatus;
    transport?: string;
    cwd?: string;
    recentError?: string;
    generation?: number;
    lastConnectedAt?: string | number;
    /** 后端能力信息：原样透传不解释；null 表示断线，缺失表示未提供 */
    capabilities?: unknown | null;
    sessionBindings?: SessionBindingSnapshot[];
}
export interface AgentStatusPayload {
    agentId?: string;
    agent?: string;
    status?: string;
    crashed?: boolean;
    transport?: string;
    cwd?: string;
    error?: string;
    generation?: number;
    lastConnectedAt?: string | number;
    capabilities?: unknown | null;
    sessionBindings?: unknown;
}
/**
 * Versioned snapshots/events are monotonic per Agent. Payloads without a
 * generation remain admissible because their ordering cannot be compared.
 */
export declare function shouldAcceptAgentStatus(previous: AgentStatus | undefined, incoming: AgentStatus): boolean;
export declare function normalizeAgentStatus(payload: AgentStatusPayload, fallbackAgent?: string): AgentStatus;
/** Resolve one Agent's display/gate status from the active Agent and snapshots. */
export declare function selectAgentStatus(agentId: string, activeAgent: string, statuses: Record<string, AgentStatus>): AgentStatus;
export declare function statusLabel(status: AgentConnectionStatus): string;
