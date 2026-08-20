/**
 * gatewayClient — 网关域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * gateway_status / gateway_sessions / reload_gateway / update_agents_config
 * （scope=gateway）的 command/payload 收口 + normalize。route 写回的安全语义
 * 由 saveGatewayRouteTransaction（阶段 5B）承载。
 *
 * I12-A-BE-01 契约冻结：catalog/instances 只读 typed client 面（镜像
 * gateway/catalog.rs、gateway/instance.rs 的 camelCase wire 形状；secret 只暴露
 * credentialStatus/credentialRef，无任何凭据值字段）。命令由 BE-02 生命周期
 * 接线注册；调用未注册命令会收到 "unknown command" 结构化错误
 * （gatewayContracts classifyGatewayWriteError 分类为 blocked）。
 */
import { ClientTransport } from '../acp/agentClient'
import { normalizeGatewaySessions, normalizeGatewayStatus } from './gatewayContracts'

/** 平台 catalog 凭据字段描述（只描述，不携带值；secret 字段值永不回传）。 */
export interface AdapterCredentialField {
  key: string
  label: string
  secret: boolean
  required: boolean
}

/** 平台能力描述（镜像 AdapterCapabilities）。 */
export interface AdapterCapabilities {
  deliverText: boolean
  deliverEvent: boolean
  ingest: boolean
  maxMessageLen: number
}

/** 平台类型级描述（catalog；D-01 与实例分离，无任何实例字段/凭据值）。 */
export interface AdapterCatalogItem {
  platform: string
  label: string
  availability: 'builtIn' | 'notInstalled' | 'unsupported'
  credentialFields: AdapterCredentialField[]
  capabilities: AdapterCapabilities
}

/** Bot 实例 DTO（instance；凭据只暴露 credentialStatus/credentialRef，D-02）。 */
export interface AdapterInstance {
  id: string
  platform: string
  label: string
  enabled: boolean
  autoStart: boolean
  status: 'stopped' | 'starting' | 'connected' | 'error'
  lastError: string | null
  credentialStatus: 'missing' | 'configured' | 'invalid'
  credentialRef: string | null
}

/** I12-W5：实例创建入参（身份字段不可变；wire camelCase）。 */
export interface GatewayInstanceInput {
  id: string
  platform: string
  label: string
  enabled: boolean
  autoStart: boolean
}

/** I12-W5：实例更新入参（仅可改展示/策略字段）。 */
export interface GatewayInstanceUpdate {
  label?: string
  enabled?: boolean
  autoStart?: boolean
}

export function createGatewayClient(transport: ClientTransport) {
  return {
    status: (): Promise<unknown> => transport.invoke('gateway_status').then(normalizeGatewayStatus),
    sessions: (): Promise<unknown> => transport.invoke('gateway_sessions').then(normalizeGatewaySessions),
    reload: (): Promise<unknown> => transport.invoke('reload_gateway'),
    updateAgentsConfig: (payload: Record<string, unknown>): Promise<unknown> => transport.invoke('update_agents_config', payload),
    catalog: (): Promise<AdapterCatalogItem[]> =>
      transport.invoke('gateway_catalog') as Promise<AdapterCatalogItem[]>,
    instances: (): Promise<AdapterInstance[]> =>
      transport.invoke('gateway_instances') as Promise<AdapterInstance[]>,
    // I12-W5：实例管理 mutation（后端命令已注册）
    createInstance: (input: GatewayInstanceInput): Promise<AdapterInstance> =>
      transport.invoke('gateway_instance_create', { input }) as Promise<AdapterInstance>,
    updateInstance: (id: string, input: GatewayInstanceUpdate): Promise<AdapterInstance> =>
      transport.invoke('gateway_instance_update', { id, input }) as Promise<AdapterInstance>,
    removeInstance: (id: string): Promise<void> =>
      transport.invoke('gateway_instance_remove', { id }) as Promise<void>,
    startInstance: (id: string): Promise<AdapterInstance> =>
      transport.invoke('gateway_instance_start', { id }) as Promise<AdapterInstance>,
    stopInstance: (id: string): Promise<AdapterInstance> =>
      transport.invoke('gateway_instance_stop', { id }) as Promise<AdapterInstance>,
    restartInstance: (id: string): Promise<AdapterInstance> =>
      transport.invoke('gateway_instance_restart', { id }) as Promise<AdapterInstance>,
    setInstanceCredentials: (id: string, secret: string): Promise<AdapterInstance> =>
      transport.invoke('gateway_instance_set_credentials', { id, secret }) as Promise<AdapterInstance>,
  }
}

export type GatewayClient = ReturnType<typeof createGatewayClient>
