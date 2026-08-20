import type { PluginDataPlane } from '../../domains/pluginData/pluginNamespace.ts'

export interface TurnIdentityInput {
  id: string
  sessionId: string
  startedAt: number
  endedAt?: number
}

export interface PluginSessionDataPort {
  getSessionNamespace(sessionId: string, pluginId: string, plane: PluginDataPlane): Record<string, unknown> | undefined
  setSessionNamespace(sessionId: string, pluginId: string, plane: PluginDataPlane, patch: Record<string, unknown>): boolean
  ensureTurn(turn: TurnIdentityInput): boolean
  getTurnNamespace(turnId: string, pluginId: string, plane: PluginDataPlane): Record<string, unknown> | undefined
  setTurnNamespace(turnId: string, pluginId: string, plane: PluginDataPlane, patch: Record<string, unknown>): boolean
}

let port: PluginSessionDataPort | undefined

export function registerPluginSessionDataPort(next: PluginSessionDataPort): void {
  port = next
}

export function getPluginSessionDataPort(): PluginSessionDataPort {
  if (!port) throw new Error('Session/Turn plugin data port 尚未安装')
  return port
}

