import { useEffect, useId, useState } from 'react'
import type { NormalizedConfigOption } from './configOptionState'
import { parseConfigNumberInput } from './configOptionState'
import Select from '../ui/Select.tsx'

export interface ConfigOptionFieldProps {
  option: NormalizedConfigOption
  disabled?: boolean
  onChange: (value: unknown) => void
}

function safeIdPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '-')
  return sanitized || 'unknown'
}

export function configOptionControlId(optionId: string, reactId: string): string {
  return `config-option-${safeIdPart(optionId)}-${safeIdPart(reactId)}`
}

export default function ConfigOptionField({ option, disabled, onChange }: ConfigOptionFieldProps) {
  const controlId = configOptionControlId(option.id, useId())
  const [numberInput, setNumberInput] = useState(() => option.currentValue === '' ? '' : String(option.currentValue))

  useEffect(() => {
    if (option.type === 'number') setNumberInput(option.currentValue === '' ? '' : String(option.currentValue))
  }, [option.currentValue, option.type])

  if (option.type === 'select') {
    return <label htmlFor={controlId}>
      {option.label}
      <Select id={controlId} className="set-select" value={String(option.currentValue)} disabled={disabled} onChange={onChange} options={option.options.map(choice => ({ value: choice.id, label: choice.label }))} />
    </label>
  }
  if (option.type === 'boolean') {
    return <label htmlFor={controlId}>
      {option.label}
      <input id={controlId} type="checkbox" checked={Boolean(option.currentValue)} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    </label>
  }
  if (option.type === 'number') {
    return <label htmlFor={controlId}>
      {option.label}
      <input id={controlId} className="set-num" type="number" value={numberInput} disabled={disabled} onChange={event => {
        const rawValue = event.target.value
        setNumberInput(rawValue)
        const parsedValue = parseConfigNumberInput(rawValue)
        if (parsedValue !== undefined) onChange(parsedValue)
      }} />
    </label>
  }
  if (option.type === 'string') {
    return <label htmlFor={controlId}>
      {option.label}
      <input id={controlId} className="set-input" type="text" value={String(option.currentValue)} disabled={disabled} onChange={event => onChange(event.target.value)} />
    </label>
  }
  return <label htmlFor={controlId}>
    {option.label}
    <code id={controlId} className="config-option-raw">{JSON.stringify(option.currentValue)}</code>
  </label>
}
