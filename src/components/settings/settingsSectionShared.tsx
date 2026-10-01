import { useState } from 'react'
import SolidMount from '../../host/SolidMount'
import type { ZonePresetEntry } from '../../domains/theme/zones/index.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError'

/**
 * settingsSectionShared — Settings 主组件与各 section 子组件共享的呈现原语
 * （A-V3 拆分自 Settings.tsx，代码逐字随迁）：折叠 Group、区域预设行、
 * 错误上报/解除的 key 口径。
 *
 * #515：`ZonePresetRow` 实体已迁 `settingsSectionShared.solid.tsx`，此处留 React 薄桥
 * （批7 拆除）。`Group` 的 children 由域外 React 消费者（Settings/AgentSettingsSection/
 * GlobalPresetSection）注入 React 子树、无法跨桥，按迁移模板保留原实现；error key
 * 口径（report/resolveSettingsError）为纯函数，同此保留。
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
