import type { NormalizedConfigOption } from './configOptionState'

export interface ConfigOptionFieldProps {
  option: NormalizedConfigOption
  disabled?: boolean
  onChange: (value: unknown) => void
}

export default function ConfigOptionField({ option, disabled, onChange }: ConfigOptionFieldProps) {
  if (option.type === 'select') {
    return <select className="set-select" value={String(option.currentValue)} disabled={disabled} onChange={event => onChange(event.target.value)}>
      {option.options.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
    </select>
  }
  if (option.type === 'boolean') {
    return <input type="checkbox" checked={Boolean(option.currentValue)} disabled={disabled} onChange={event => onChange(event.target.checked)} />
  }
  if (option.type === 'number') {
    return <input className="set-num" type="number" value={Number(option.currentValue)} disabled={disabled} onChange={event => onChange(Number(event.target.value))} />
  }
  if (option.type === 'string') {
    return <input className="set-input" type="text" value={String(option.currentValue)} disabled={disabled} onChange={event => onChange(event.target.value)} />
  }
  return <code className="config-option-raw">{JSON.stringify(option.currentValue)}</code>
}
