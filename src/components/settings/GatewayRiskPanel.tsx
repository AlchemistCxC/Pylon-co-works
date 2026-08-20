import { useEffect, useState } from 'react'
import { IS_TAURI } from '../../infrastructure/tauri/env'
import { createGatewayClient } from '../../infrastructure/tauri/gatewayClient'
import { invoke } from '@tauri-apps/api/core'
import type { AdapterInstance } from '../../infrastructure/tauri/gatewayClient'

// FE-AUD-008：typed client 收口 gateway 域 command literal
const gatewayClient = createGatewayClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })

const credentialLabel = (status: AdapterInstance['credentialStatus']): string =>
  status === 'configured' ? '已配置' : status === 'invalid' ? '损坏' : '未配置'

const statusLabel = (status: AdapterInstance['status']): string =>
  status === 'connected' ? '已连接' : status === 'starting' ? '启动中' : status === 'error' ? '错误' : '已停止'

/** Tauri invoke 拒绝值为 { code, message } 对象（非 Error）——提取 message 展示（CR-001）。 */
function errorMessage(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'message' in cause) {
    const message = (cause as { message: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(cause)
}

/**
 * GatewayRiskPanel — Settings「Agent 与连接 › Gateway」风险 consumer（ISSUE-13 W5）。
 *
 * 只消费 ISSUE-12 的真实 capability（gatewayClient catalog/instances + credentialStatus），
 * 准确提示备份/凭据边界，**不伪装备份加密**：
 * - 凭据加密存储（版本化加密 envelope + 系统主密钥），日志/导出/UI 永不回显 secret；
 * - Gateway 凭据不进入通用设置导出（secret 不在 CONFIG_STORAGE_KEYS）；
 * - 安全备份能力尚未提供——不生成含凭据的备份，请勿假定已存在加密备份。
 */
export default function GatewayRiskPanel() {
  const [instances, setInstances] = useState<AdapterInstance[] | null>(null)
  const [loading, setLoading] = useState(IS_TAURI)
  const [error, setError] = useState<string | null>(null)

  const reload = () => {
    if (!IS_TAURI) {
      setInstances([])
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    gatewayClient
      .instances()
      .then(list => setInstances(list))
      .catch(cause => setError(`读取 Gateway 实例失败：${errorMessage(cause)}`))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
  }, [])

  const configuredCount = instances?.filter(i => i.credentialStatus === 'configured').length ?? 0
  const invalidCount = instances?.filter(i => i.credentialStatus === 'invalid').length ?? 0
  const missingCount = instances?.filter(i => i.credentialStatus === 'missing').length ?? 0

  return (
    <div className="set-group">
      <h3 className="set-group-inner-title">Gateway 连接与备份</h3>
      {!IS_TAURI ? (
        <div className="set-hint">Gateway 管理需要 Tauri 后端。</div>
      ) : error ? (
        <>
          <div className="set-hint" role="alert">{error}</div>
          <div className="set-preset-row">
            <button type="button" className="ps-btn sm" onClick={reload}>重试</button>
          </div>
        </>
      ) : loading || instances === null ? (
        <div className="set-hint">正在加载 Gateway 实例…</div>
      ) : (
        <>
          {instances.length === 0 ? (
            <div className="set-hint">尚未创建 Gateway 实例。</div>
          ) : (
            <div className="set-preset-row">
              <span className="set-hint">
                实例 {instances.length} 个：已配置凭据 {configuredCount}、
                未配置 {missingCount}
                {invalidCount > 0 ? `、损坏 ${invalidCount}` : ''}
              </span>
            </div>
          )}
          {instances.map(instance => (
            <div className="set-row" key={instance.id}>
              <span className="set-row-label">{instance.platform}</span>
              <span className="set-hint" style={{ margin: 0 }}>
                {instance.label} · {statusLabel(instance.status)}
                {instance.lastError ? ` · ${instance.lastError}` : ''}
                {' · '}凭据：{credentialLabel(instance.credentialStatus)}
              </span>
            </div>
          ))}
          {missingCount > 0 && (
            <div className="set-hint set-impact">有实例未配置凭据，无法连接。</div>
          )}
          <div className="set-hint">
            Gateway 凭据以加密 envelope 存储（系统主密钥保护），日志、界面与导出永不回显 secret。
          </div>
          <div className="set-hint set-impact">
            安全备份能力尚未提供：Gateway 凭据不进入通用设置导出，当前不会生成包含凭据的备份，
            请勿假定已存在加密备份。
          </div>
        </>
      )}
    </div>
  )
}
