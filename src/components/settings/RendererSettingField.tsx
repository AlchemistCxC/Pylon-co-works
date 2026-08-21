import type { ChangeEvent } from 'react'
import type { RenderSettingCondition, RenderSettingField, RendererSettingOption, RendererSettingValue } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { settingFieldKey } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'

export interface RendererSettingFieldProps {
  readonly field: RenderSettingField
  readonly value: RendererSettingValue | undefined
  readonly options?: readonly RendererSettingOption[]
  onChange(value: RendererSettingValue): void
  onReset?(): void
}

export function evaluateRenderSettingCondition(condition: RenderSettingCondition | undefined, values: Readonly<Record<string, RendererSettingValue>>): boolean {
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

export default function RendererSettingField(props: RendererSettingFieldProps) {
  const label = labelOf(props.field)
  const fieldId = `renderer-setting-${settingFieldKey(props.field)}`
  const value = props.value
  const options = props.options ?? ('options' in props.field ? props.field.options : [])
  const reset = props.onReset && props.field.default !== undefined
    ? <button type="button" className="set-field-reset" aria-label={`${label}恢复默认`} onClick={props.onReset}>↺</button>
    : null

  switch (props.field.type) {
    case 'choice':
      return <div className="renderer-setting-field" data-setting-key={settingFieldKey(props.field)}>
        <label htmlFor={fieldId}>{label}</label>
        <select id={fieldId} aria-label={label} value={typeof value === 'string' ? value : ''} onChange={event => changeText(event, props.onChange)}>
          {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label ?? option.value}</option>)}
        </select>{reset}
        {props.field.description && <small>{props.field.description}</small>}
      </div>
    case 'multi-choice': {
      const selected = Array.isArray(value) ? value.filter(item => typeof item === 'string') as string[] : []
      return <fieldset className="renderer-setting-field" data-setting-key={settingFieldKey(props.field)} aria-label={label}>
        <legend>{label}</legend>
        {options.map(option => <label key={option.value}>
          <input type="checkbox" checked={selected.includes(option.value)} disabled={option.disabled} onChange={event => props.onChange(event.currentTarget.checked ? [...selected, option.value] : selected.filter(item => item !== option.value))} />
          {option.label ?? option.value}
        </label>)}{reset}
      </fieldset>
    }
    case 'color': {
      const color = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'
      return <div className="renderer-setting-field" data-setting-key={settingFieldKey(props.field)}>
        <label htmlFor={fieldId}>{label}</label>
        <input id={fieldId} aria-label={label} type="color" value={color} onChange={event => props.onChange(event.currentTarget.value)} />{reset}
      </div>
    }
    case 'number':
      return <div className="renderer-setting-field" data-setting-key={settingFieldKey(props.field)}>
        <label htmlFor={fieldId}>{label}</label>
        <input id={fieldId} aria-label={label} type={props.field.presentation === 'slider' ? 'range' : 'number'} min={props.field.min} max={props.field.max} step={props.field.step} value={typeof value === 'number' ? value : props.field.default as number ?? ''} onChange={event => props.onChange(Number(event.currentTarget.value))} />{reset}
        {props.field.unit && <span>{props.field.unit}</span>}
      </div>
    case 'boolean':
      return <label className="renderer-setting-field" data-setting-key={settingFieldKey(props.field)}>
        <input aria-label={label} type="checkbox" checked={value === true} onChange={event => props.onChange(event.currentTarget.checked)} />
        {label}{reset}
      </label>
    case 'text':
      return <div className="renderer-setting-field" data-setting-key={settingFieldKey(props.field)}>
        <label htmlFor={fieldId}>{label}</label>
        {props.field.presentation === 'textarea'
          ? <textarea id={fieldId} aria-label={label} value={typeof value === 'string' ? value : ''} placeholder={props.field.placeholder} maxLength={props.field.maxLength} onChange={event => changeText(event, props.onChange)} />
          : <input id={fieldId} aria-label={label} value={typeof value === 'string' ? value : ''} placeholder={props.field.placeholder} maxLength={props.field.maxLength} onChange={event => changeText(event, props.onChange)} />}{reset}
      </div>
  }
}
