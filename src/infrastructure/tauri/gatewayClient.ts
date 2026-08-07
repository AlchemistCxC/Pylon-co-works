/**
 * gatewayClient — 网关域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * gateway_status / gateway_sessions / reload_gateway / update_agents_config
 * （scope=gateway）的 command/payload 收口 + normalize。route 写回的安全语义
 * 由 saveGatewayRouteTransaction（阶段 5B）承载。
 */
import { ClientTransport } from '../acp/agentClient'
import { normalizeGatewaySessions, normalizeGatewayStatus } from './gatewayContracts'

export function createGatewayClient(transport: ClientTransport) {
  return {
    status: (): Promise<unknown> => transport.invoke('gateway_status').then(normalizeGatewayStatus),
    sessions: (): Promise<unknown> => transport.invoke('gateway_sessions').then(normalizeGatewaySessions),
    reload: (): Promise<unknown> => transport.invoke('reload_gateway'),
    updateAgentsConfig: (payload: Record<string, unknown>): Promise<unknown> => transport.invoke('update_agents_config', payload),
  }
}

export type GatewayClient = ReturnType<typeof createGatewayClient>
