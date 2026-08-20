import type { PluginIdentity } from '../pluginIdentity.ts'
import { getPluginSessionDataPort, type TurnIdentityInput } from './sessionDataPort.ts'

function cloneNamespace(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : {}
}

export interface PluginSessionsApi {
  getPluginMetadata(sessionId: string): Record<string, unknown>
  setPluginMetadata(sessionId: string, patch: Record<string, unknown>): boolean
  getPluginContext(sessionId: string): Record<string, unknown>
  setPluginContext(sessionId: string, patch: Record<string, unknown>): boolean
}

export interface PluginTurnsApi {
  ensure(turn: TurnIdentityInput): boolean
  getPluginMetadata(turnId: string): Record<string, unknown>
  setPluginMetadata(turnId: string, patch: Record<string, unknown>): boolean
  getPluginContext(turnId: string): Record<string, unknown>
  setPluginContext(turnId: string, patch: Record<string, unknown>): boolean
}

export function createPluginSessionDataApis(identity: PluginIdentity): {
  sessions: PluginSessionsApi
  turns: PluginTurnsApi
} {
  const pluginId = identity.pluginId
  return {
    sessions: {
      getPluginMetadata: sessionId => cloneNamespace(
        getPluginSessionDataPort().getSessionNamespace(sessionId, pluginId, 'metadata'),
      ),
      setPluginMetadata: (sessionId, patch) => (
        getPluginSessionDataPort().setSessionNamespace(sessionId, pluginId, 'metadata', patch)
      ),
      getPluginContext: sessionId => cloneNamespace(
        getPluginSessionDataPort().getSessionNamespace(sessionId, pluginId, 'context'),
      ),
      setPluginContext: (sessionId, patch) => (
        getPluginSessionDataPort().setSessionNamespace(sessionId, pluginId, 'context', patch)
      ),
    },
    turns: {
      ensure: turn => getPluginSessionDataPort().ensureTurn(turn),
      getPluginMetadata: turnId => cloneNamespace(
        getPluginSessionDataPort().getTurnNamespace(turnId, pluginId, 'metadata'),
      ),
      setPluginMetadata: (turnId, patch) => (
        getPluginSessionDataPort().setTurnNamespace(turnId, pluginId, 'metadata', patch)
      ),
      getPluginContext: turnId => cloneNamespace(
        getPluginSessionDataPort().getTurnNamespace(turnId, pluginId, 'context'),
      ),
      setPluginContext: (turnId, patch) => (
        getPluginSessionDataPort().setTurnNamespace(turnId, pluginId, 'context', patch)
      ),
    },
  }
}
