import { useEffect, useMemo, useState } from 'react'
import { PYLON_PLUGIN_CAPABILITIES } from '../../plugin-runtime/packageManifest.ts'
import {
  getPluginCapabilityGrantStore,
} from '../../plugin-runtime/management/pluginManagementWiring.ts'
import type { KernelBootstrap } from '../../kernel/kernelBootstrap.ts'

/**
 * P53 D2 · 宿主授权卡：声明了 capability 但未获用户授权的插件在此批准/拒绝。
 * 授权数据 host-owned（grant store）；批准后经 bootstrap.retryPlugin 自然激活。
 * 这是宿主职责（同意流的 UI 载体），不属于任何插件 API。
 */
export interface PluginCapabilityConsentCardProps {
  /** 待授权声明清单：bootstrap capability-consent 失败投影。 */
  readonly pending: readonly {
    pluginId: string
    pluginVersion: string
    capabilities: readonly string[]
    message: string
  }[]
  readonly bootstrap?: Pick<KernelBootstrap, 'retryPlugin'>
}

export default function PluginCapabilityConsentCard({
  pending,
  bootstrap,
}: PluginCapabilityConsentCardProps) {
  const store = getPluginCapabilityGrantStore()
  const [grantsSnapshot, setGrantsSnapshot] = useState(() => store.snapshot())
  useEffect(() => {
    setGrantsSnapshot(store.snapshot())
    return store.subscribe(() => { setGrantsSnapshot(store.snapshot()) })
  }, [store])
  const [busy, setBusy] = useState(false)
  const grantedKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const [pluginId, capabilities] of Object.entries(grantsSnapshot)) {
      for (const [capability, record] of Object.entries(capabilities)) {
        keys.add(`${pluginId}:${capability}:${record.pluginVersion}`)
      }
    }
    return keys
  }, [grantsSnapshot])

  if (pending.length === 0) return null

  const decide = async (
    pluginId: string,
    pluginVersion: string,
    capability: string,
    approve: boolean,
  ) => {
    setBusy(true)
    try {
      if (approve) {
        store.grant(pluginId, capability as (typeof PYLON_PLUGIN_CAPABILITIES)[number], {
          pluginVersion,
          apiVersion: '1.2',
        })
        await bootstrap?.retryPlugin(pluginId)
      } else {
        store.revoke(pluginId, capability as (typeof PYLON_PLUGIN_CAPABILITIES)[number])
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="set-group" data-capability-consent-card aria-label="插件能力授权">
      <div className="set-group-title" aria-expanded="true">能力授权</div>
      <div className="set-hint">
        以下插件在 manifest 中声明了宿主能力（{PYLON_PLUGIN_CAPABILITIES.join('/')}），需要你批准后才能激活。
      </div>
      {pending.map(item => item.capabilities.map(capability => {
        const granted = grantedKeys.has(`${item.pluginId}:${capability}:${item.pluginVersion}`)
        return (
          <div className="plugin-row" key={`${item.pluginId}:${capability}`}>
            <span className="plugin-row-id">{item.pluginId}</span>
            <span className="plugin-type-badge type-first-party">{capability}</span>
            <span className="set-hint">{item.message}</span>
            <div className="plugin-row-actions">
              {granted
                ? <span className="plugin-state-badge is-active">已授权</span>
                : (
                  <>
                    <button
                      type="button"
                      className="ps-btn primary sm"
                      disabled={busy}
                      aria-label={`批准 ${item.pluginId} 的 ${capability} 能力`}
                      onClick={() => { void decide(item.pluginId, item.pluginVersion, capability, true) }}
                    >
                      批准
                    </button>
                    <button
                      type="button"
                      className="ps-btn sm"
                      disabled={busy}
                      aria-label={`拒绝 ${item.pluginId} 的 ${capability} 能力`}
                      onClick={() => { void decide(item.pluginId, item.pluginVersion, capability, false) }}
                    >
                      拒绝
                    </button>
                  </>
                )}
            </div>
          </div>
        )
      }))}
    </div>
  )
}
