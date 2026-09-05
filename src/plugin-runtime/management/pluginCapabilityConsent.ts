import { PYLON_PLUGIN_CAPABILITIES, type PylonPluginCapability } from '../packageManifest.ts'
import type { PluginCapabilityGrantStore } from './pluginCapabilityGrants.ts'

/**
 * API 1.2 capability 同意流评估（P53 D1，纯函数）。
 *
 * manifest 声明了 capability 但宿主授权缺失/失效 → `awaiting_consent`：
 * 内置包进 bootstrap 失败列表（stage `capability-consent`，可重试），
 * 外置包激活前置失败（typed diagnostic `plugin_capability_denied`）。
 * 授权/拒绝动作是宿主职责（D2 授权卡），不属于任何插件 API。
 */

export type PluginCapabilityConsentStatus = 'granted' | 'awaiting_consent'

export interface PluginCapabilityConsentEvaluation {
  readonly status: PluginCapabilityConsentStatus
  readonly pluginId: string
  readonly pluginVersion: string
  readonly declaredCapabilities: readonly PylonPluginCapability[]
  readonly missingCapabilities: readonly PylonPluginCapability[]
}

export function evaluatePluginCapabilityConsent(options: {
  readonly pluginId: string
  readonly pluginVersion: string
  readonly capabilities?: readonly string[]
  readonly grants: Pick<PluginCapabilityGrantStore, 'getGrant'>
}): PluginCapabilityConsentEvaluation {
  // manifest 解析已保证词表封闭；过滤仅作防御（未知词不参与同意判定）
  const declared = (options.capabilities ?? []).filter((capability): capability is PylonPluginCapability => (
    (PYLON_PLUGIN_CAPABILITIES as readonly string[]).includes(capability)
  ))
  const missing = declared.filter(capability => (
    options.grants.getGrant(options.pluginId, capability, options.pluginVersion) === undefined
  ))
  return {
    status: missing.length === 0 ? 'granted' : 'awaiting_consent',
    pluginId: options.pluginId,
    pluginVersion: options.pluginVersion,
    declaredCapabilities: declared,
    missingCapabilities: missing,
  }
}
