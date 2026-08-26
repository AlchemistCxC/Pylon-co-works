import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

const COLOR_CHIPS = ['#a855f7', '#3b82f6', '#34d399', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#ffffff', '#000000']
const RECENT_LIMIT = 6
let recentColors: string[] = []

export interface ColorChoice {
  readonly value: string
  readonly label?: string
  readonly disabled?: boolean
}

interface Props {
  value: string
  onChange: (value: string) => void
  /** false = 直接原生取色器，不弹预设板（紧凑场景用） */
  chips?: boolean
  /** 字段级候选色；插件设置选项贡献不修改全局色板。 */
  palette?: readonly ColorChoice[]
  /** 可继承的宿主语义色。仅由确认支持 CSS token 的 owner 传入。 */
  semanticTokens?: readonly ColorChoice[]
  /** 允许编辑 alpha。CSS token 的 alpha 由 token owner 控制。 */
  allowAlpha?: boolean
  /** 字段语义标签（渲染器设置按字段命名触发按钮，供 label 关联与读屏）。 */
  ariaLabel?: string
}

function pickerColor(value: string): string {
  const normalized = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized
  const short = normalized.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  const alphaHex = normalized.match(/^#([0-9a-f]{6})[0-9a-f]{2}$/i)
  if (alphaHex) return `#${alphaHex[1]}`
  return '#000000'
}

function alphaOf(value: string): number | undefined {
  const normalized = value.trim()
  const alphaHex = normalized.match(/^#[0-9a-f]{6}([0-9a-f]{2})$/i)
  if (alphaHex) return Math.round((Number.parseInt(alphaHex[1], 16) / 255) * 100)
  const rgba = normalized.match(/^rgba?\(\s*\d+[ ,]+\d+[ ,]+\d+(?:\s*[,/]\s*(0|1|0?\.\d+|\d+%))?\s*\)$/i)
  if (!rgba?.[1]) return normalized === 'transparent' ? 0 : /^#[0-9a-f]{3,6}$/i.test(normalized) ? 100 : undefined
  return rgba[1].endsWith('%') ? Number.parseFloat(rgba[1]) : Number.parseFloat(rgba[1]) * 100
}

function withAlpha(value: string, alphaPercent: number): string | undefined {
  const alpha = Math.max(0, Math.min(100, alphaPercent))
  const raw = value.trim()
  const rgb = raw.match(/^rgba?\(\s*(\d{1,3})[ ,]+(\d{1,3})[ ,]+(\d{1,3})(?:\s*[,/]\s*(?:0|1|0?\.\d+|\d+%))?\s*\)$/i)
  const base = pickerColor(raw)
  if (!rgb && base === '#000000' && !/^#(?:000|000000|000000[0-9a-f]{2})$/i.test(raw) && raw !== 'transparent') return undefined
  const red = rgb ? Number(rgb[1]) : Number.parseInt(base.slice(1, 3), 16)
  const green = rgb ? Number(rgb[2]) : Number.parseInt(base.slice(3, 5), 16)
  const blue = rgb ? Number(rgb[3]) : Number.parseInt(base.slice(5, 7), 16)
  return `rgb(${red} ${green} ${blue} / ${Number((alpha / 100).toFixed(2))})`
}

function colorKind(value: string): string {
  if (value.trim() === 'transparent') return '透明'
  if (/^var\(--[A-Za-z0-9_-]+\)$/.test(value.trim())) return '语义令牌'
  if (/^#/.test(value.trim())) return '十六进制'
  if (/^(?:rgb|hsl|oklch|color)\(/i.test(value.trim())) return 'CSS 颜色'
  return '原始 CSS'
}

export default function ColorPopover({ value, onChange, chips = true, palette, semanticTokens, allowAlpha = false, ariaLabel }: Props) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [recent, setRecent] = useState<readonly string[]>(recentColors)
  const pickerRef = useRef<HTMLInputElement>(null)
  const choices: readonly ColorChoice[] = palette ?? COLOR_CHIPS.map(color => ({ value: color, label: color }))
  const alpha = alphaOf(value)

  useEffect(() => setDraft(value), [value])

  const commit = (next: string) => {
    const normalized = next.trim()
    if (!normalized) {
      setDraft(value)
      return
    }
    onChange(normalized)
    setDraft(normalized)
    recentColors = [normalized, ...recentColors.filter(item => item !== normalized)].slice(0, RECENT_LIMIT)
    setRecent(recentColors)
  }
  const commitDraft = () => commit(draft)
  const handleDraftKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitDraft()
    }
    if (event.key === 'Escape') {
      setDraft(value)
      setOpen(false)
    }
  }
  const choose = (next: string) => {
    commit(next)
    setOpen(false)
  }

  if (!chips) {
    return (
      <div className="set-color-direct">
        <button type="button" className="set-swatch" aria-label={ariaLabel ?? '选择颜色'} style={{ background: value || 'transparent' }} onClick={() => pickerRef.current?.click()} />
        <code title={value}>{value}</code>
        <input ref={pickerRef} type="color" value={pickerColor(value)} onChange={event => commit(event.target.value)} className="set-swatch-input" />
      </div>
    )
  }

  return (
    <div className="set-color-wrap">
      <button type="button" className="set-color-trigger" aria-label={ariaLabel ?? '打开颜色选择器'} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="set-swatch" style={{ background: value || 'transparent' }} />
        <span className="set-color-trigger-copy"><code>{value}</code><small>{colorKind(value)}</small></span>
      </button>
      {open && <>
        <div className="set-color-popover" role="dialog" aria-label={`${ariaLabel ?? '颜色'}设置`}>
          <div className="set-color-current">
            <span className="set-color-current-sample" style={{ background: value || 'transparent' }} />
            <div><small>当前值</small><strong>{colorKind(value)}</strong></div>
          </div>
          <label className="set-color-value-input">
            <span>CSS / HEX / RGBA</span>
            <input value={draft} spellCheck={false} onChange={event => setDraft(event.currentTarget.value)} onBlur={commitDraft} onKeyDown={handleDraftKey} />
          </label>
          {semanticTokens && semanticTokens.length > 0 && <ColorChoiceRow label="跟随语义色" choices={semanticTokens} value={value} onChoose={choose} />}
          <ColorChoiceRow label="调色板" choices={choices} value={value} onChoose={choose} />
          {recent.length > 0 && <ColorChoiceRow label="最近使用" choices={recent.map(item => ({ value: item }))} value={value} onChoose={choose} />}
          {allowAlpha && <label className="set-color-alpha">
            <span>透明度</span>
            {alpha === undefined
              ? <small>语义 token 的透明度由其 owner 控制</small>
              : <><input type="range" min="0" max="100" step="1" value={alpha} onChange={event => {
                const next = withAlpha(value, Number(event.currentTarget.value))
                if (next) commit(next)
              }} /><output>{Math.round(alpha)}%</output></>}
          </label>}
          <button type="button" className="set-color-custom" onClick={() => pickerRef.current?.click()}>打开系统色盘</button>
        </div>
        <button type="button" className="set-color-backdrop" aria-label="关闭颜色选择器" onClick={() => setOpen(false)} />
      </>}
      <input ref={pickerRef} type="color" value={pickerColor(value)} onChange={event => { commit(event.target.value); setOpen(false) }} className="set-swatch-input" />
    </div>
  )
}

function ColorChoiceRow(props: {
  readonly label: string
  readonly choices: readonly ColorChoice[]
  readonly value: string
  onChoose(value: string): void
}) {
  return <div className="set-color-choice-group">
    <span>{props.label}</span>
    <div className="set-color-row">
      {props.choices.map(choice => <button type="button" key={choice.value}
        className={`set-color-chip ${props.value === choice.value ? 'active' : ''}`}
        aria-label={`选择颜色 ${choice.label ?? choice.value}`}
        title={choice.label ?? choice.value}
        disabled={choice.disabled}
        style={{ background: choice.value }}
        onClick={() => props.onChoose(choice.value)} />)}
    </div>
  </div>
}
