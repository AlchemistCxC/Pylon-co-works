import type { ChangeEvent } from 'react'
import * as Switch from '@radix-ui/react-switch'
import * as Slider from '@radix-ui/react-slider'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import type { RenderSettingField, RendererSettingOption, RendererPresentation, RendererSettingValue } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { resolvePresentation, settingFieldKey } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import ColorPopover from '../ColorPopover.tsx'

export interface RendererSettingFieldProps {
  readonly field: RenderSettingField
  readonly value: RendererSettingValue | undefined
  readonly options?: readonly RendererSettingOption[]
  onChange(value: RendererSettingValue): void
  onReset?(): void
}

export function evaluateRenderSettingCondition(condition: RenderSettingField['showIf'], values: Readonly<Record<string, RendererSettingValue>>): boolean {
  if (!condition) return true
  if ('equals' in condition) return Object.is(values[condition.equals.field], condition.equals.value)
  if ('oneOf' in condition) return condition.oneOf.values.some(value => Object.is(values[condition.oneOf.field], value))
  if ('not' in condition) return !evaluateRenderSettingCondition(condition.not, values)
  if ('all' in condition) return condition.all.every(item => evaluateRenderSettingCondition(item, values))
  return condition.any.some(item => evaluateRenderSettingCondition(item, values))
}

function labelOf(field: RenderSettingField): string {
  return field.label || settingFieldKey(field)
}

function changeText(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>, onChange: RendererSettingFieldProps['onChange']): void {
  onChange(event.currentTarget.value)
}

/** S2：segmented 按钮组（横排 chip，active 用 accent 底）。 */
function SegmentedControl({ options, value, onChange, ariaLabel }: {
  options: readonly RendererSettingOption[]
  value: string
  onChange(value: string): void
  ariaLabel?: string
}) {
  return (
    // K-3：底座升级 Radix ToggleGroup——键盘导航/roving focus 由 Radix 承担，外观类名沿用
    <ToggleGroup.Root
      type="single"
      className="renderer-segmented"
      aria-label={ariaLabel}
      value={value}
      onValueChange={next => { if (next !== '') onChange(next) }}
    >
      {options.map(option => (
        <ToggleGroup.Item key={option.value} value={option.value} disabled={option.disabled}
          data-state={option.value === value ? 'on' : 'off'}
          className={`renderer-segmented-chip${option.value === value ? ' active' : ''}`}>
          {option.label ?? option.value}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}

/** S2：toggle 开关（role=switch）。 */
function ToggleSwitch({ checked, onChange, ariaLabel }: { checked: boolean; onChange(checked: boolean): void; ariaLabel: string }) {
  // K-3：Radix Switch——role=switch/键盘/焦点由 Radix 提供，data-state 驱动样式
  return (
    <Switch.Root checked={checked} onCheckedChange={onChange} aria-label={ariaLabel}
      className={`set-toggle${checked ? ' on' : ''}`} data-state={checked ? 'on' : 'off'} />
  )
}

export default function RendererSettingField(props: RendererSettingFieldProps) {
  const field = props.field
  const value = props.value
  const label = labelOf(field)
  const fieldId = `renderer-setting-${settingFieldKey(field)}`
  const presentation: RendererPresentation = resolvePresentation(field)
  const options = props.options ?? ('options' in field ? field.options : [])
  const reset = props.onReset && field.default !== undefined
    ? <button type="button" className="set-field-reset" aria-label={`${label}恢复默认`} onClick={props.onReset}>↺</button>
    : null

  switch (field.type) {
    case 'choice': {
      if (presentation === 'radio') {
        return <fieldset className="renderer-setting-field" data-setting-key={settingFieldKey(field)} aria-label={label}>
          <legend>{label}</legend>
          {options.map(option => <label key={option.value}>
            <input type="radio" name={fieldId} value={option.value} checked={value === option.value}
              disabled={option.disabled} onChange={() => props.onChange(option.value)} />
            {option.label ?? option.value}
          </label>)}{reset}
          {field.description && <small>{field.description}</small>}
        </fieldset>
      }
      if (presentation === 'segmented') {
        return <div className="renderer-setting-field" data-setting-key={settingFieldKey(field)}>
          <span className="renderer-setting-label">{label}</span>
          <SegmentedControl options={options} value={typeof value === 'string' ? value : ''} onChange={props.onChange} ariaLabel={label} />{reset}
          {field.description && <small>{field.description}</small>}
        </div>
      }
      return <div className="renderer-setting-field" data-setting-key={settingFieldKey(field)}>
        <label htmlFor={fieldId}>{label}</label>
        <select id={fieldId} aria-label={label} value={typeof value === 'string' ? value : ''} onChange={event => changeText(event, props.onChange)}>
          {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label ?? option.value}</option>)}
        </select>{reset}
        {field.description && <small>{field.description}</small>}
      </div>
    }
    case 'multi-choice': {
      const selected = Array.isArray(value) ? value.filter(item => typeof item === 'string') as string[] : []
      if (presentation === 'listbox') {
        return <div className="renderer-setting-field" data-setting-key={settingFieldKey(field)}>
          <label htmlFor={fieldId}>{label}</label>
          <select id={fieldId} multiple size={Math.max(1, Math.min(6, options.length))} aria-label={label}
            value={selected} onChange={event => props.onChange(Array.from(event.currentTarget.selectedOptions).map(option => option.value))}>
            {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label ?? option.value}</option>)}
          </select>{reset}
        </div>
      }
      return <fieldset className="renderer-setting-field" data-setting-key={settingFieldKey(field)} aria-label={label}>
        <legend>{label}</legend>
        {options.map(option => <label key={option.value}>
          <input type="checkbox" checked={selected.includes(option.value)} disabled={option.disabled} onChange={event => props.onChange(event.currentTarget.checked ? [...selected, option.value] : selected.filter(item => item !== option.value))} />
          {option.label ?? option.value}
        </label>)}{reset}
      </fieldset>
    }
    case 'color': {
      const color = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'
      // palette→色板为主；picker→直接原生取色；palette+picker→默认（chips+自定义入口）
      const chips = presentation !== 'picker'
      return <div className="renderer-setting-field" data-setting-key={settingFieldKey(field)}>
        <span className="renderer-setting-label">{label}</span>
        <ColorPopover value={color} chips={chips} ariaLabel={label}
          palette={options.length > 0 ? options.map(option => ({ value: option.value, label: option.label, disabled: option.disabled })) : undefined}
          onChange={v => props.onChange(v)} />{reset}
      </div>
    }
    case 'number': {
      const numericValue = typeof value === 'number' ? value : typeof field.default === 'number' ? field.default : undefined
      if (presentation === 'slider+input') {
        return <div className="renderer-setting-field renderer-number-duo" data-setting-key={settingFieldKey(field)}>
          <label htmlFor={fieldId}>{label}</label>
          {/* K-3：range 半边升级 Radix Slider（键盘/焦点管理内建）；数值半边保留原生 */}
          <Slider.Root id={fieldId} className="renderer-slider" aria-label={label}
            min={field.min ?? 0} max={field.max ?? 100} step={field.step}
            value={[numericValue ?? 0]} onValueChange={values => props.onChange(Number(values[0]))}>
            <Slider.Track className="renderer-slider-track">
              <Slider.Range className="renderer-slider-range" />
            </Slider.Track>
            <Slider.Thumb className="renderer-slider-thumb" aria-label={`${label}滑块`} />
          </Slider.Root>
          <input type="number" aria-label={`${label}数值`} min={field.min ?? 0} max={field.max ?? 100} value={numericValue ?? 0}
            onChange={event => props.onChange(Number(event.currentTarget.value))} />
          {field.unit && <span>{field.unit}</span>}{reset}
        </div>
      }
      return <div className="renderer-setting-field" data-setting-key={settingFieldKey(field)}>
        <label htmlFor={fieldId}>{label}</label>
        <input id={fieldId} aria-label={label} type={presentation === 'slider' ? 'range' : 'number'} min={field.min} max={field.max} step={field.step} value={numericValue ?? ''} onChange={event => props.onChange(Number(event.currentTarget.value))} />{reset}
        {field.unit && <span>{field.unit}</span>}
      </div>
    }
    case 'boolean': {
      if (presentation === 'toggle') {
        return <div className="renderer-setting-field" data-setting-key={settingFieldKey(field)}>
          <ToggleSwitch checked={value === true} onChange={props.onChange} ariaLabel={label} />
          <span className="renderer-setting-label">{label}</span>{reset}
        </div>
      }
      return <label className="renderer-setting-field" data-setting-key={settingFieldKey(field)}>
        <input aria-label={label} type="checkbox" checked={value === true} onChange={event => props.onChange(event.currentTarget.checked)} />
        {label}{reset}
      </label>
    }
    case 'text':
      return <div className="renderer-setting-field" data-setting-key={settingFieldKey(field)}>
        <label htmlFor={fieldId}>{label}</label>
        {presentation === 'textarea'
          ? <textarea id={fieldId} aria-label={label} value={typeof value === 'string' ? value : ''} placeholder={field.placeholder} maxLength={field.maxLength} onChange={event => changeText(event, props.onChange)} />
          : <input id={fieldId} aria-label={label} value={typeof value === 'string' ? value : ''} placeholder={field.placeholder} maxLength={field.maxLength} onChange={event => changeText(event, props.onChange)} />}{reset}
      </div>
  }
}
