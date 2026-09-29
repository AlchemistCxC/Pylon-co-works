import { Fragment, useState } from 'react'
import { useStore } from '../../domains/theme/themeStore'
import { zonePresetsFor, isCustomZonePresetEntry, type ZonePresetEntry } from '../../domains/theme/zones/index.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError'

/**
 * settingsSectionShared — Settings 主组件与各 section 子组件共享的呈现原语
 * （A-V3 拆分自 Settings.tsx，代码逐字随迁）：折叠 Group、区域预设行、
 * 错误上报/解除的 key 口径。
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

/**
 * 刀6（#206）：区域预设行。候选不再是「平铺 10 个整体预设」，而是该
 * (界面模式桶, 区域) 的池条目——出厂条目（存引用，应用时现场切）+ 自定义条目（存值快照）。
 * 未登记归属桶的界面模式（如 tactical-blue）⇒ 池为空 ⇒ **整组不渲染**（与刀5 同口径）。
 */
export function ZonePresetRow({ zone, interfaceMode, activeName, isDirty, onApply, onSaveCurrent, onRemoveEntry }: {
  zone: ZonePresetEntry['zone']; interfaceMode: string; activeName: string; isDirty: boolean
  onApply: (zone: ZonePresetEntry['zone'], entry: ZonePresetEntry) => void
  onSaveCurrent: (zone: ZonePresetEntry['zone'], name: string) => void
  onRemoveEntry: (id: string) => void
}) {
  const customEntries = useStore(s => s.zonePresetEntries)
  const entries = zonePresetsFor(interfaceMode, zone, customEntries)
  const [entryName, setEntryName] = useState('')
  // 刀7 前置（#211）：行内两段式确认的待删条目（照全局自定义预设先例，不常驻、不开模态）
  const [pendingDeleteEntryId, setPendingDeleteEntryId] = useState<string | null>(null)
  if (entries.length === 0) return null
  return (
    <Group title="局部预设">
      <div className="set-preset-row">
        {entries.map(entry => {
          const selected = activeName === entry.id && !isDirty
          // 刀7 前置（#211）出现条件：**只在自定义条目**上；普通条目「被选中才出现」
          // （那排 chip 本来就挤），Q8 灰显占位条目常驻——那是它唯一的自然出口。
          // 刀2（#223）起判据是显式来源字段 `origin`：出厂条目（`origin:'factory'`）**任何情况下**
          // 都不进入这一段（铁律 1：出厂件不可改、不可删）。
          const deletable = isCustomZonePresetEntry(entry) && (entry.stale === true || selected)
          return (
            <Fragment key={entry.id}>
              <button type="button"
                className={`set-preset-chip ${selected ? 'active' : ''}`}
                aria-current={selected ? 'true' : undefined}
                // Q8：清理后已无有效字段的自定义条目 = 行内占位（灰显、不可应用）；不给用户开关。
                disabled={entry.stale === true}
                title={entry.stale
                  ? '该条目引用的字段已被删除，值已自动清理，不能再应用'
                  : undefined}
                onClick={() => onApply(zone, entry)}>{entry.label}</button>
              {deletable && (pendingDeleteEntryId === entry.id ? (
                <div className="set-confirm set-confirm-inline" role="alertdialog" aria-label={`确认删除区域预设 ${entry.label}`}>
                  <span className="set-confirm-text">删除后不可恢复；将移除本区的自定义条目「{entry.label}」，本区保留现值但失去该预设基准。</span>
                  <div className="set-confirm-actions">
                    <button type="button" className="ps-btn sm danger"
                      onClick={() => { setPendingDeleteEntryId(null); onRemoveEntry(entry.id) }}>确认删除</button>
                    <button type="button" className="ps-btn sm" onClick={() => setPendingDeleteEntryId(null)}>取消</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="ps-btn sm danger"
                  onClick={() => setPendingDeleteEntryId(entry.id)}>删除</button>
              ))}
            </Fragment>
          )
        })}
        {isDirty && <span className="set-preset-chip active">自定义</span>}
      </div>
      <div className="set-hint">只改本区外观参数，自动切换为自定义；改动后可存成属于本区的自定义条目</div>
      <div className="set-custom-preset-save">
        <input className="set-input" value={entryName} onChange={event => setEntryName(event.target.value)} placeholder="区域预设名称" />
        <button type="button" className="ps-btn sm" disabled={!entryName.trim()} title={entryName.trim() ? undefined : '保存必须命名'}
          onClick={() => { onSaveCurrent(zone, entryName); setEntryName('') }}>存当前</button>
      </div>
    </Group>
  )
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
