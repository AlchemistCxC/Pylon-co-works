import type { PluginDataPlane } from '../../domains/pluginData/pluginNamespace.js';
export interface TurnIdentityInput {
    id: string;
    sessionId: string;
    startedAt: number;
    endedAt?: number;
}
export interface PluginSessionDataPort {
    getSessionNamespace(sessionId: string, pluginId: string, plane: PluginDataPlane): Record<string, unknown> | undefined;
    setSessionNamespace(sessionId: string, pluginId: string, plane: PluginDataPlane, patch: Record<string, unknown>): boolean;
    ensureTurn(turn: TurnIdentityInput): boolean;
    getTurnNamespace(turnId: string, pluginId: string, plane: PluginDataPlane): Record<string, unknown> | undefined;
    setTurnNamespace(turnId: string, pluginId: string, plane: PluginDataPlane, patch: Record<string, unknown>): boolean;
}
export declare function registerPluginSessionDataPort(next: PluginSessionDataPort): void;
export declare function getPluginSessionDataPort(): PluginSessionDataPort;
