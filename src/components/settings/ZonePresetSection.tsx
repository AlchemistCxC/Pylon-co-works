import { useStore } from '../../domains/theme/themeStore'
import { deriveZoneStatus } from '../../domains/theme/presetReducer'
import { ZonePresetRow } from './settingsSectionShared.tsx'
import type { ZonePresetEntry } from '../../domains/theme/zones/index.ts'

/**
 * ZonePresetSection — 区域分区（sidebar/chat/cc/right）的同构骨架（A-V3 拆分自
 * Settings.tsx 四段重复 JSX）：分区标题 + 可选头部组 + 局部预设行 + 声明式字段组
 * （fields 经 props 注入，renderCtx/density 保持单源）+ 可选尾部组（如 cc 的布局
 * 编辑器入口）。区域预设状态派生（appliedName/isCustom）在本组件内完成。
 */
export default function ZonePresetSection({ zone, label, isSearching, interfaceMode, fields, header, footer, onApplyZonePreset, onSaveZonePresetEntry, onRemoveZonePresetEntry }: {
  /** 区域分区骨架只服务具名 section 区（global 的组合不同，走 GlobalPresetSection）。 */
  zone: 'sidebar' | 'chat' | 'cc' | 'right'
  label?: string
  isSearching: boolean
  interfaceMode: string
  fields: React.ReactNode
  header?: React.ReactNode
  footer?: React.ReactNode
  onApplyZonePreset: (zone: ZonePresetEntry['zone'], entry: ZonePresetEntry) => void
  onSaveZonePresetEntry: (zone: ZonePresetEntry['zone'], name: string) => void
  onRemoveZonePresetEntry: (id: string) => void
}) {
  const appliedPreset = useStore(s => s.appliedPreset)
  const custom = useStore(s => s.custom)

  const status = deriveZoneStatus({ appliedPreset, custom }, zone)
  return (
    <>
      {!isSearching && label != null && <h3>{label}</h3>}
      {header}
      {!isSearching && (
        <ZonePresetRow zone={zone} interfaceMode={interfaceMode} activeName={status.appliedName} isDirty={status.isCustom}
          onApply={onApplyZonePreset} onSaveCurrent={onSaveZonePresetEntry} onRemoveEntry={onRemoveZonePresetEntry} />
      )}
      {fields}
      {footer}
    </>
  )
}
