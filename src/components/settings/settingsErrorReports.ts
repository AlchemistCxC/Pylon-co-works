import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError'

/**
 * Settings 域内错误上报/解除的统一 key 口径（settingsAgentActions、
 * AgentRuntimePanel 与预设事务共用）。
 *
 * #515 W1：原与 Group/ZonePresetRow 同住 settingsSectionShared（React 面）——
 * 该域 Solid 化收口时拆出纯 TS 模块：`.ts` 面在 React/Solid 两个类型图里都收纳，
 * 不得静态引用 `.solid.tsx`；实体侧 settingsSectionShared.solid.tsx 从这里转发同名
 * 导出，消费者接口不变。
 */
export function reportSettingsError(action: string, error: unknown, agentId?: string): ReturnType<typeof reportRuntimeError> {
  return reportRuntimeError(action, error, agentId, {
    key: `settings:${action}:${agentId ?? 'app'}`,
    scope: agentId ? { kind: 'agent', id: agentId } : { kind: 'app', id: 'settings' },
    source: 'settings',
  })
}

export function resolveSettingsError(action: string, agentId?: string): void {
  resolveRuntimeErrors({
    key: `settings:${action}:${agentId ?? 'app'}`,
  })
}
