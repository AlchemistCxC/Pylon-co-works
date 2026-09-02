import type { PluginIdentity } from '../pluginIdentity.js';
import { type TurnIdentityInput } from './sessionDataPort.js';
export interface PluginSessionsApi {
    getPluginMetadata(sessionId: string): Record<string, unknown>;
    setPluginMetadata(sessionId: string, patch: Record<string, unknown>): boolean;
    getPluginContext(sessionId: string): Record<string, unknown>;
    setPluginContext(sessionId: string, patch: Record<string, unknown>): boolean;
}
export interface PluginTurnsApi {
    ensure(turn: TurnIdentityInput): boolean;
    getPluginMetadata(turnId: string): Record<string, unknown>;
    setPluginMetadata(turnId: string, patch: Record<string, unknown>): boolean;
    getPluginContext(turnId: string): Record<string, unknown>;
    setPluginContext(turnId: string, patch: Record<string, unknown>): boolean;
}
export declare function createPluginSessionDataApis(identity: PluginIdentity): {
    sessions: PluginSessionsApi;
    turns: PluginTurnsApi;
};
