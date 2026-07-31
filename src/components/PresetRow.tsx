import { useStore } from '../store'
import { GLOBAL_PRESETS, pickZoneFields } from '../presets'

interface Props { area: string }

/**
 * PresetRow — 区域内的预设快捷选择（thin chip row）
 *
 * 现在 presets 系统已升级到 zone 模型（global/sidebar/chat/cc/right），
 * 本组件保留旧的 area 命名（terminal/cc）作为 alias，自动映射到 chat/cc。
 */
const AREA_TO_ZONE: Record<string, string> = {
  terminal: 'chat',
  cc: 'cc',
}

const BUILTIN: Record<string, { name: string; label: string }[]> = {
  terminal: [
    { name: 'claude', label: 'Claude Code' },
    { name: 'glass',  label: 'Glass Light' },
    { name: 'nord',   label: 'Nord Frost' },
  ],
  cc: [
    { name: 'claude', label: 'Claude Code' },
    { name: 'glass',  label: 'Glass Light' },
    { name: 'nord',   label: 'Nord Frost' },
  ],
}

export default function PresetRow({ area }: Props) {
  const builtin = BUILTIN[area] || []
  const zone = AREA_TO_ZONE[area] || area
  const activeName = useStore(s => s.activePreset[zone] || '')
  const dirty = useStore(s => s.dirty[zone] || false)
  const applyZonePreset = useStore(s => s.applyZonePreset)

  const apply = (name: string) => {
    const preset = GLOBAL_PRESETS.find(p => p.name === name)
    if (!preset) return
    const sub = pickZoneFields(preset.theme, zone)
    applyZonePreset(zone, name, sub)
  }

  if (builtin.length === 0) return null
  return (
    <div className="preset-row">
      <span className="preset-label">预设</span>
      <div className="preset-chips">
        {builtin.map(p => (
          <button key={p.name} className={`preset-chip ${!dirty && activeName === p.name ? 'active' : ''}`}
            onClick={() => apply(p.name)}>{p.label}</button>
        ))}
        {dirty && <span className="preset-chip active">自定义</span>}
      </div>
    </div>
  )
}