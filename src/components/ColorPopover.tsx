import { useRef, useState } from 'react'

// 共享取色器 — Settings 与 ControlCenter 统一使用
// swatch 色块 → 点击弹出预设色板 + 自定义入口（原生 color picker）

const COLOR_CHIPS = ['#a855f7', '#3b82f6', '#34d399', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#ffffff', '#000000']

interface Props {
  value: string
  onChange: (v: string) => void
  /** false = 直接原生取色器，不弹预设板（紧凑场景用） */
  chips?: boolean
  /** 字段级候选色；插件设置选项贡献不修改全局色板。 */
  palette?: readonly { value: string; label?: string; disabled?: boolean }[]
}

export default function ColorPopover({ value, onChange, chips = true, palette }: Props) {
  const [open, setOpen] = useState(false)
  const pickerRef = useRef<HTMLInputElement>(null)
  const choices: readonly { value: string; label?: string; disabled?: boolean }[] = palette
    ?? COLOR_CHIPS.map(color => ({ value: color, label: color }))

  if (!chips) {
    return (
      <>
        <button type="button" className="set-swatch" aria-label="选择颜色" style={{ background: value || 'transparent' }} onClick={() => pickerRef.current?.click()} />
        <input ref={pickerRef} type="color" value={value || '#000000'} onChange={e => onChange(e.target.value)} className="set-swatch-input" />
      </>
    )
  }

  return (
    <div className="set-color-wrap">
      <button type="button" className="set-swatch" aria-label="打开颜色选择器" aria-expanded={open} style={{ background: value || 'transparent' }} onClick={() => setOpen(!open)} />
      {open && <>
        <div className="set-color-popover">
          <div className="set-color-row">
            {choices.map(choice => (
              <button type="button" key={choice.value} className={`set-color-chip ${value === choice.value ? 'active' : ''}`}
                aria-label={choice.label ? `选择颜色 ${choice.label}` : `选择颜色 ${choice.value}`}
                title={choice.label} disabled={choice.disabled}
                style={{ background: choice.value }} onClick={() => { onChange(choice.value); setOpen(false) }} />
            ))}
          </div>
          <button className="set-color-custom" onClick={() => pickerRef.current?.click()}>自定义…</button>
        </div>
        <button type="button" className="set-color-backdrop" aria-label="关闭颜色选择器" onClick={() => setOpen(false)} />
      </>}
      <input ref={pickerRef} type="color" value={value || '#000000'} onChange={e => { onChange(e.target.value); setOpen(false) }} className="set-swatch-input" />
    </div>
  )
}
