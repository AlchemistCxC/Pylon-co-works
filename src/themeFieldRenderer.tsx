import { Fragment, useState } from 'react'
import type { ThemeSettings } from './store'
import { GROUP_ORDER, THEME_FIELD_DEFS, THEME_FIELD_KEYS, type ThemeFieldDef, type ThemeFieldKey, type ZoneName } from './themeFieldDefs'
import ColorPopover from './components/ColorPopover'
import { resolveBackgroundImage } from './backgroundImage'
import { resolveSpinnerFrames } from './components/chat/spinnerFrames'

/**
 * themeFieldRenderer — 声明式字段渲染器（自定义系统骨架）。
 *
 * 按 THEME_FIELD_DEFS 类型/控件标识 + GROUP_ORDER（分区/组/compact）渲染
 * Settings 字段区。能力：type 分发、特殊控件（bgImage/spinnerMarker/
 * schemeChip）、showIf 条件、advanced 折叠、suffix 后缀、hint 提示、
 * compact 紧凑行、h3 分区。
 */

interface RenderCtx {
  t: ThemeSettings & { ccEditMode: boolean }
  onChange: (partial: Partial<ThemeSettings>) => void
  /** 设置搜索：按字段 label 过滤；非空时强制展开全部匹配组 */
  search?: string
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

function Group({ title, children, defaultOpen, forceOpen }: { title: string; children: React.ReactNode; defaultOpen?: boolean; forceOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? true)
  const visible = open || forceOpen === true
  return (
    <div className="set-group">
      <button type="button" className="set-group-title" aria-expanded={visible} onClick={() => setOpen(!visible)}>
        <span className="set-group-arrow">{visible ? '▾' : '▸'}</span>
        {title}
      </button>
      {visible && children}
    </div>
  )
}

function BgImageControl({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const resolved = resolveBackgroundImage(value)
  const openFile = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ multiple: false, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] })
      if (selected) onChange(selected as string)
    } catch { /* browser fallback */ }
  }
  return (
    <>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} className="set-input" style={{ width: '160px' }} placeholder="路径或 URL" />
      <button className="ps-btn sm" onClick={openFile}>选择</button>
      {value && <>
        <div className={`set-bg-preview ${resolved.error ? 'error' : ''}`} style={{ backgroundImage: resolved.cssValue }}
          onClick={() => onChange('')} title={resolved.error ? `加载失败：${resolved.error}；点击清除` : '点击清除'} />
        {resolved.error && <span className="set-bg-error" role="alert">{resolved.error}</span>}
      </>}
    </>
  )
}

function SpinnerMarkerControl({ mode, value, frames, onModeChange, onValueChange }: {
  mode: string
  value: string
  frames: string[]
  onModeChange: (v: string) => void
  onValueChange: (v: string) => void
}) {
  const safeFrames = frames.length > 0 ? frames : ['·']
  return (
    <>
      <Sel value={mode} onChange={onModeChange} options={['frame', 'custom']} />
      {mode === 'frame'
        ? <Sel value={safeFrames.includes(value) ? value : safeFrames[0]} onChange={onValueChange} options={safeFrames} />
        : <Txt value={value} onChange={onValueChange} />}
    </>
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

/** number 显示后缀（percent 时值 *100） */
function formatDisplayValue(value: unknown, def: ThemeFieldDef): string {
  const num = Number(value ?? 0)
  const display = def.percent ? Math.round(num * 100) : num
  return `${display}${def.suffix ?? ''}`
}

/** 控件本体（不含 Row 包装；compact 行内联复用） */
function FieldControl({ def, ctx, keyName }: { def: ThemeFieldDef; ctx: RenderCtx; keyName: ThemeFieldKey }) {
  const { t, onChange } = ctx
  const value = t[keyName]

  if (def.control === 'bgImage') {
    return <BgImageControl value={String(value ?? '')} onChange={v => onChange({ [keyName]: v } as Partial<ThemeSettings>)} />
  }

  if (def.control === 'spinnerMarker') {
    const modeKey = spinnerMarkerModeKey(keyName)
    const frames = resolveSpinnerFrames(t.spinnerFramePreset, t.spinnerCustomFrames)
    return (
      <SpinnerMarkerControl
        mode={modeKey ? String(t[modeKey] ?? 'frame') : 'custom'}
        value={String(value ?? '')}
        frames={frames}
        onModeChange={v => { if (modeKey) onChange({ [modeKey]: v } as Partial<ThemeSettings>) }}
        onValueChange={v => onChange({ [keyName]: v } as Partial<ThemeSettings>)}
      />
    )
  }

  if (def.control === 'schemeChip') {
    return (
      <div className="set-preset-row">
        <button type="button" className={`set-preset-chip ${value === 'light' ? 'active' : ''}`} onClick={() => onChange({ [keyName]: 'light' } as Partial<ThemeSettings>)}>浅色</button>
        <button type="button" className={`set-preset-chip ${value === 'dark' ? 'active' : ''}`} onClick={() => onChange({ [keyName]: 'dark' } as Partial<ThemeSettings>)}>深色</button>
      </div>
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
      return <ColorPopover value={String(value ?? '')} onChange={v => emit({ [keyName]: v } as Partial<ThemeSettings>)} chips={false} />
    case 'number': {
      const min = def.minFn ? def.minFn(t as ThemeSettings) : (def.min ?? 0)
      return (
        <>
          <Slider value={Number(value ?? 0)} onChange={v => emit({ [keyName]: v } as Partial<ThemeSettings>)} min={min} max={def.max ?? 100} step={def.step} />
          <Num value={Number(value ?? 0)} onChange={v => emit({ [keyName]: v } as Partial<ThemeSettings>)} min={min} max={def.max} />
          {def.suffix && <span className="set-val">{formatDisplayValue(value, def)}</span>}
        </>
      )
    }
    case 'select':
      return <Sel value={String(value ?? '')} onChange={v => emit({ [keyName]: v } as Partial<ThemeSettings>)} options={def.options ?? []} />
    case 'boolean':
      return <Sel value={value ? 'on' : 'off'} onChange={v => emit({ [keyName]: v === 'on' } as Partial<ThemeSettings>)} options={[{ value: 'on', label: '开' }, { value: 'off', label: '关' }]} />
    case 'text':
      return <Txt value={String(value ?? '')} onChange={v => emit({ [keyName]: v } as Partial<ThemeSettings>)} />
  }
}

function FieldRow({ def, ctx, keyName }: { def: ThemeFieldDef; ctx: RenderCtx; keyName: ThemeFieldKey }) {
  const value = ctx.t[keyName]
  const atDefault = def.default !== undefined && Object.is(value, def.default)
  return (
    <Row label={def.label}>
      <FieldControl def={def} ctx={ctx} keyName={keyName} />
      {def.default !== undefined && !atDefault && (
        <button type="button" className="set-field-reset" aria-label="恢复默认"
          title={`恢复默认`} onClick={() => ctx.onChange({ [keyName]: def.default } as Partial<ThemeSettings>)}>↺</button>
      )}
      {def.hint && <div className="set-hint">{def.hint}</div>}
    </Row>
  )
}

function renderGroupFields(fields: ThemeFieldKey[], ctx: RenderCtx) {
  const regular = fields.filter(key => !(THEME_FIELD_DEFS[key] as ThemeFieldDef).advanced)
  const advanced = fields.filter(key => (THEME_FIELD_DEFS[key] as ThemeFieldDef).advanced)
  // 搜索时 advanced 字段内联展开（不藏进"高级…"，否则命中项不可见）
  const searching = (ctx.search?.trim() ?? '').length > 0
  const advancedRows = advanced.map(key => {
    const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
    return <FieldRow key={key} keyName={key} def={def} ctx={ctx} />
  })
  return (
    <>
      {regular.map(key => {
        const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
        return <FieldRow key={key} keyName={key} def={def} ctx={ctx} />
      })}
      {advanced.length > 0 && (searching
        ? advancedRows
        : (
          <details className="set-advanced">
            <summary>高级…</summary>
            {advancedRows}
          </details>
        ))}
    </>
  )
}

function renderCompactGroup(fields: ThemeFieldKey[], ctx: RenderCtx) {
  const regular = fields.filter(key => !(THEME_FIELD_DEFS[key] as ThemeFieldDef).advanced)
  return (
    <div className="set-compact-row">
      {regular.map(key => {
        const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
        const value = ctx.t[key]
        const atDefault = def.default !== undefined && Object.is(value, def.default)
        return (
          <Fragment key={key}>
            <span className="set-compact-label">{def.label}</span>
            <FieldControl def={def} ctx={ctx} keyName={key} />
            {def.default !== undefined && !atDefault && (
              <button type="button" className="set-field-reset compact" aria-label="恢复默认"
                onClick={() => ctx.onChange({ [key]: def.default } as Partial<ThemeSettings>)}>↺</button>
            )}
          </Fragment>
        )
      })}
      {fields.some(key => (THEME_FIELD_DEFS[key] as ThemeFieldDef).advanced) && (
        <details className="set-advanced">
          <summary>高级…</summary>
          {fields.filter(key => (THEME_FIELD_DEFS[key] as ThemeFieldDef).advanced).map(key => {
            const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
            return <FieldRow key={key} keyName={key} def={def} ctx={ctx} />
          })}
        </details>
      )}
    </div>
  )
}

/**
 * 渲染某 zone 的字段区：GROUP_ORDER 提供 分区（h3）→ 组（可 compact）两级。
 * 字段从 defs 按 group 自动收集；hidden 跳过、showIf 条件过滤。
 */
export function ZoneGroupFields({ zone, ctx }: { zone: ZoneName; ctx: RenderCtx }) {
  const sections = GROUP_ORDER[zone]
  if (!sections) return null
  const query = ctx.search?.trim().toLowerCase() ?? ''
  const searching = query.length > 0
  return (
    <>
      {sections.map((section, si) => {
        const groups = section.groups
          .map(group => {
            const fields = THEME_FIELD_KEYS.filter(key => {
              const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
              return def.zone === zone && def.group === group.title && !def.hidden
                && (!def.showIf || def.showIf(ctx.t as ThemeSettings))
                && (!searching || def.label.toLowerCase().includes(query))
            })
            return { ...group, fields }
          })
          .filter(group => group.fields.length > 0)
        if (groups.length === 0) return null
        return (
          <Fragment key={section.heading ?? si}>
            {section.heading && <h3>{section.heading}</h3>}
            {groups.map(group => (
              <Group key={group.title} title={group.title} defaultOpen={group.defaultOpen} forceOpen={searching}>
                {group.compact
                  ? renderCompactGroup(group.fields, ctx)
                  : renderGroupFields(group.fields, ctx)}
              </Group>
            ))}
          </Fragment>
        )
      })}
    </>
  )
}
