import { useRef, useState } from 'react'

// 共享取色器 — Settings 与 ControlCenter 统一使用
// swatch 色块 → 点击弹出预设色板 + 自定义入口（原生 color picker）

const COLOR_CHIPS = ['#a855f7', '#3b82f6', '#34d399', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#ffffff', '#000000']

interface Props {
  value: string
  onChange: (v: string) => void
  /** false = 直接原生取色器，不弹预设板（紧凑场景用） */
  chips?: boolean
}

export default function ColorPopover({ value, onChange, chips = true }: Props) {
  const [open, setOpen] = useState(false)
  const pickerRef = useRef<HTMLInputElement>(null)

  if (!chips) {
    return (
      <>
        <div className="set-swatch" style={{ background: value || 'transparent' }} onClick={() => pickerRef.current?.click()} />
        <input ref={pickerRef} type="color" value={value || '#000000'} onChange={e => onChange(e.target.value)} className="set-swatch-input" />
      </>
    )
  }

  return (
    <div className="set-color-wrap">
      <div className="set-swatch" style={{ background: value || 'transparent' }} onClick={() => setOpen(!open)} />
      {open && <>
        <div className="set-color-popover">
          <div className="set-color-row">
            {COLOR_CHIPS.map(c => (
              <div key={c} className={`set-color-chip ${value === c ? 'active' : ''}`}
                style={{ background: c }} onClick={() => { onChange(c); setOpen(false) }} />
            ))}
          </div>
          <button className="set-color-custom" onClick={() => pickerRef.current?.click()}>自定义…</button>
        </div>
        <div className="set-color-backdrop" onClick={() => setOpen(false)} />
      </>}
      <input ref={pickerRef} type="color" value={value || '#000000'} onChange={e => { onChange(e.target.value); setOpen(false) }} className="set-swatch-input" />
    </div>
  )
}
