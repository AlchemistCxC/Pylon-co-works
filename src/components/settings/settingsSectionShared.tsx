import { useState } from 'react'
import SolidMount from '../../host/SolidMount'
import type { ZonePresetEntry } from '../../domains/theme/zones/index.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError'

/**
 * settingsSectionShared — Settings 主组件与各 section 子组件共享的呈现原语
 * （A-V3 拆分自 Settings.tsx，代码逐字随迁）：折叠 Group、区域预设行、
 * 错误上报/解除的 key 口径。
 *
 * #515 第二批收尾：Solid 面（Group/report/resolveSettingsError/ZonePresetRow 实体）
 * 已齐备于 `settingsSectionShared.solid.tsx`。本文件保留的理由只剩「React 世界仍有无
 * 法跨桥的消费者」：`Group` 的 children 由域外 React 消费者（AgentSettingsSection——
 * 在途避让域；ZonePresetSection）注入 React 子树，error key 口径被 settingsAgentActions
 * （避让域）消费——这些消费者 Solid 化后本文件随批7 拆除；实体侧不做静态回向引用。
 */

export function Group({ title, children, defaultOpen }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? true)
  return (
    <div className="set-group">
      <button type="button" className="set-group-title" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="set-group-arrow">{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && children}
    </div>
  )
}

export interface ZonePresetRowProps {
  zone: ZonePresetEntry['zone']; interfaceMode: string; activeName: string; isDirty: boolean
  onApply: (zone: ZonePresetEntry['zone'], entry: ZonePresetEntry) => void
  onSaveCurrent: (zone: ZonePresetEntry['zone'], name: string) => void
  onRemoveEntry: (id: string) => void
}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface SettingsSectionSharedSolidModule {
  renderZonePresetRow(container: HTMLElement, latest: () => ZonePresetRowProps): () => void
}

const modules = import.meta.glob<SettingsSectionSharedSolidModule>('./settingsSectionShared.solid.tsx', { eager: true })
const solidModule = modules['./settingsSectionShared.solid.tsx']
if (!solidModule) throw new Error('settingsSectionShared Solid 实体未进入 Vite module graph')

/** 刀6（#206）区域预设行——#515：实体在 settingsSectionShared.solid.tsx，本文件是薄桥。 */
export function ZonePresetRow(props: ZonePresetRowProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderZonePresetRow(container, latest)} />
}

/** Settings 域内错误上报/解除的统一 key 口径（agentActions 与预设事务共用）。 */
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
