import type { ConfigOption, ConfigOptionChoice } from '../chat/acpTypes'

export interface NormalizedConfigOptionChoice {
  id: string
  label: string
}

export interface NormalizedConfigOption {
  id: string
  label: string
  type: 'select' | 'boolean' | 'string' | 'number' | 'unknown'
  currentValue: unknown
  options: NormalizedConfigOptionChoice[]
  raw: ConfigOption
}

function optionId(option: ConfigOption): string {
  return String(option.id ?? option.key ?? option.name ?? 'unknown')
}

function choiceId(choice: ConfigOptionChoice): string {
  return String(choice.id ?? choice.value ?? choice.name ?? choice.label ?? '')
}

function optionChoices(option: ConfigOption): NormalizedConfigOptionChoice[] {
  const choices = option.options ?? option.choices ?? option.values ?? option.available ?? []
  return choices
    .map(choice => ({ id: choiceId(choice), label: String(choice.name ?? choice.label ?? choice.value ?? choice.id ?? '') }))
    .filter(choice => choice.id.length > 0)
}

function optionType(option: ConfigOption, choices: NormalizedConfigOptionChoice[]): NormalizedConfigOption['type'] {
  const type = String(option.type ?? '').toLowerCase()
  if (type === 'boolean' || type === 'bool') return 'boolean'
  if (type === 'number' || type === 'integer' || type === 'float') return 'number'
  if (choices.length > 0 || type === 'select' || type === 'enum') return 'select'
  if (type === 'string' || type === 'text') return 'string'
  const value = option.currentValue ?? option.value ?? option.current ?? option.selected
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'string'
  return 'unknown'
}

export function normalizeConfigOption(option: ConfigOption): NormalizedConfigOption {
  const options = optionChoices(option)
  return {
    id: optionId(option),
    label: String(option.name ?? option.id ?? option.key ?? '未命名选项'),
    type: optionType(option, options),
    currentValue: option.currentValue ?? option.value ?? option.current ?? option.selected ?? '',
    options,
    raw: option,
  }
}

export function normalizeConfigOptions(options: unknown): NormalizedConfigOption[] {
  if (!Array.isArray(options)) return []
  return options
    .filter((option): option is ConfigOption => Boolean(option && typeof option === 'object'))
    .map(normalizeConfigOption)
}

export function parseConfigNumberInput(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
