import { useStore } from '../store'

interface Props { area: string }

const BUILTIN: Record<string, { name: string; colors: Record<string,string> }[]> = {
  terminal: [
    { name:'Terminal Light', colors:{ chatBg:'transparent', chatTextColor:'rgba(0,0,0,0.85)', chatCodeBg:'rgba(0,0,0,0.03)' }},
    { name:'Dracula', colors:{ chatBg:'#1e1e2e', chatTextColor:'#cdd6f4', chatCodeBg:'rgba(255,255,255,0.05)' }},
  ],
  cc: [
    { name:'Glass', colors:{ ccBg:'rgba(255,255,255,0.04)' }},
    { name:'Dark Glass', colors:{ ccBg:'rgba(0,0,0,0.15)' }},
  ],
}

export default function PresetRow({ area }: Props) {
  const builtin = BUILTIN[area] || []
  const active = useStore(s => s.activePreset[area] || '')
  const updateTheme = useStore(s => s.updateTheme)

  const apply = (name: string) => {
    const preset = builtin.find(p => p.name === name)
    if (!preset) return
    updateTheme(preset.colors as any)
    useStore.setState(s => ({ activePreset: { ...s.activePreset, [area]: name } }))
  }

  if (builtin.length === 0) return null
  return (
    <div className="preset-row">
      <span className="preset-label">配色</span>
      <div className="preset-chips">
        {builtin.map(p => (
          <button key={p.name} className={`preset-chip ${active === p.name ? 'active' : ''}`}
            onClick={() => apply(p.name)}>{p.name}</button>
        ))}
      </div>
    </div>
  )
}
