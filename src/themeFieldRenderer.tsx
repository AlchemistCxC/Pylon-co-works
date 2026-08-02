import { useState } from 'react'
import type { ThemeSettings } from './store'
import { GROUP_MAP, THEME_FIELD_DEFS, type ThemeFieldDef, type ThemeFieldKey, type ZoneName } from './themeFieldDefs'
import ColorPopover from './components/ColorPopover'
import { resolveBackgroundImage } from './backgroundImage'
import { resolveSpinnerFrames } from './components/chat/spinnerFrames'

/**
 * themeFieldRenderer — 声明式字段渲染器（自定义系统骨架 3）。
 *
 * 按 THEME_FIELD_DEFS 的类型/控件标识 + GROUP_MAP 分组渲染 Settings 字段区，
 * 特殊控件（背景图/Spinner marker）经 control 标识分发。纯字段组从此
 * 无需手写 Row；新增字段进 defs + GROUP_MAP 即自动出现 UI。
 */

interface RenderCtx {
  t: ThemeSettings & { ccEditMode: boolean }
  onChange: (partial: Partial<ThemeSettings>) => void
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="set-row"><span className="set-row-label">{label}</span>{children}</div>
}

export function Slider({ value, onChange, min, max, step }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  return <input type="range" min={min} max={max} step={step || 0.05} value={value}
    onChange={e => onChange(+e.target.value)} className="set-range" />
}

export function Num({ value, onChange, min, max }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return <input type="number" min={min} max={max} value={value} step={0.1}
    onChange={e => onChange(+e.target.value)} className="set-num" />
}

export function Sel({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: readonly string[] | (string | { value: string; label: string })[] }) {
  return <select value={value} onChange={e => onChange(e.target.value)} className="set-select">
    {options.map(option => {
      const item = typeof option === 'string' ? { value: option, label: option } : option
      return <option key={item.value} value={item.value}>{item.label}</option>
    })}
  </select>
}

export function Txt({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input type="text" value={value} onChange={e => onChange(e.target.value)} className="set-input" />
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
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

function BgImageRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const resolved = resolveBackgroundImage(value)
  const openFile = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ multiple: false, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] })
      if (selected) onChange(selected as string)
    } catch { /* browser fallback */ }
  }
  return (
    <Row label={label}>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} className="set-input" style={{ width: '160px' }} placeholder="路径或 URL" />
      <button className="ps-btn sm" onClick={openFile}>选择</button>
      {value && <>
        <div className={`set-bg-preview ${resolved.error ? 'error' : ''}`} style={{ backgroundImage: resolved.cssValue }}
          onClick={() => onChange('')} title={resolved.error ? `加载失败：${resolved.error}；点击清除` : '点击清除'} />
        {resolved.error && <span className="set-bg-error" role="alert">{resolved.error}</span>}
      </>}
    </Row>
  )
}

function SpinnerMarkerRow({ label, mode, value, frames, onModeChange, onValueChange }: {
  label: string
  mode: string
  value: string
  frames: string[]
  onModeChange: (v: string) => void
  onValueChange: (v: string) => void
}) {
  const safeFrames = frames.length > 0 ? frames : ['·']
  return (
    <Row label={label}>
      <Sel value={mode} onChange={onModeChange} options={['frame', 'custom']} />
      {mode === 'frame'
        ? <Sel value={safeFrames.includes(value) ? value : safeFrames[0]} onChange={onValueChange} options={safeFrames} />
        : <Txt value={value} onChange={onValueChange} />}
    </Row>
  )
}

/** spinner 完成/取消/错误标记配套的 mode 字段名 */
function spinnerMarkerModeKey(key: string): ThemeFieldKey | null {
  const map: Record<string, ThemeFieldKey> = {
    spinnerDoneMarker: 'spinnerDoneMarkerMode',
    spinnerCancelledMarker: 'spinnerCancelledMarkerMode',
    spinnerErrorMarker: 'spinnerErrorMarkerMode',
  }
  return map[key] ?? null
}

function FieldRow({ def, ctx, keyName }: { def: ThemeFieldDef; ctx: RenderCtx; keyName: ThemeFieldKey }) {
  const { t, onChange } = ctx
  const value = t[keyName]

  if (def.control === 'bgImage') {
    return <BgImageRow label={def.label} value={String(value ?? '')} onChange={v => onChange({ [keyName]: v } as Partial<ThemeSettings>)} />
  }

  if (def.control === 'spinnerMarker') {
    const modeKey = spinnerMarkerModeKey(keyName)
    const frames = resolveSpinnerFrames(t.spinnerFramePreset, t.spinnerCustomFrames)
    return (
      <SpinnerMarkerRow
        label={def.label}
        mode={modeKey ? String(t[modeKey] ?? 'frame') : 'custom'}
        value={String(value ?? '')}
        frames={frames}
        onModeChange={v => { if (modeKey) onChange({ [modeKey]: v } as Partial<ThemeSettings>) }}
        onValueChange={v => onChange({ [keyName]: v } as Partial<ThemeSettings>)}
      />
    )
  }

  const emit = (partial: Partial<ThemeSettings>) => {
    const next: Partial<ThemeSettings> = { ...partial }
    if (def.syncOnChange && partial[keyName] !== undefined) {
      for (const syncKey of def.syncOnChange) {
        if (syncKey === 'inputMode') {
          next.inputMode = partial[keyName] === 'cli' ? 'cli' : 'default'
        } else {
          (next as Record<string, unknown>)[syncKey] = partial[keyName]
        }
      }
    }
    onChange(next)
  }

  switch (def.type) {
    case 'color':
      return (
        <Row label={def.label}>
          <ColorPopover value={String(value ?? '')} onChange={v => emit({ [keyName]: v } as Partial<ThemeSettings>)} chips={false} />
        </Row>
      )
    case 'number': {
      const min = def.minFn ? def.minFn(t as ThemeSettings) : (def.min ?? 0)
      return (
        <Row label={def.label}>
          <Slider value={Number(value ?? 0)} onChange={v => emit({ [keyName]: v } as Partial<ThemeSettings>)} min={min} max={def.max ?? 100} step={def.step} />
          <Num value={Number(value ?? 0)} onChange={v => emit({ [keyName]: v } as Partial<ThemeSettings>)} min={min} max={def.max} />
        </Row>
      )
    }
    case 'select':
      return (
        <Row label={def.label}>
          <Sel value={String(value ?? '')} onChange={v => emit({ [keyName]: v } as Partial<ThemeSettings>)} options={def.options ?? []} />
        </Row>
      )
    case 'boolean':
      return (
        <Row label={def.label}>
          <Sel value={value ? 'on' : 'off'} onChange={v => emit({ [keyName]: v === 'on' } as Partial<ThemeSettings>)} options={[{ value: 'on', label: '开' }, { value: 'off', label: '关' }]} />
        </Row>
      )
    case 'text':
      return (
        <Row label={def.label}>
          <Txt value={String(value ?? '')} onChange={v => emit({ [keyName]: v } as Partial<ThemeSettings>)} />
        </Row>
      )
  }
}

/** 渲染某 zone 的纯字段组（GROUP_MAP 驱动）；hidden 字段跳过 */
export function ZoneGroupFields({ zone, ctx }: { zone: ZoneName; ctx: RenderCtx }) {
  const groups = GROUP_MAP[zone]
  if (!groups) return null
  return (
    <>
      {Object.entries(groups).map(([title, fields]) => (
        <Group key={title} title={title}>
          {fields.map(key => {
            const def = THEME_FIELD_DEFS[key]
            if (!def || def.hidden) return null
            return <FieldRow key={key} keyName={key} def={def} ctx={ctx} />
          })}
        </Group>
      ))}
    </>
  )
}
