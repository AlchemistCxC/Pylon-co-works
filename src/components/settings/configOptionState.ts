import {
  extractChoiceId,
  extractChoiceLabel,
  extractConfigOptionChoices,
  extractConfigOptionId,
  extractConfigOptionValue,
  type ConfigOption,
} from '../../infrastructure/acp/chatContracts'

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
  return extractConfigOptionId(option) ?? 'unknown'
}

function optionChoices(option: ConfigOption): NormalizedConfigOptionChoice[] {
  return extractConfigOptionChoices(option)
    .map(choice => {
      const id = extractChoiceId(choice)
      return id ? { id, label: extractChoiceLabel(choice, id) ?? id } : undefined
    })
    .filter((choice): choice is NormalizedConfigOptionChoice => Boolean(choice))
}

function optionType(option: ConfigOption, choices: NormalizedConfigOptionChoice[]): NormalizedConfigOption['type'] {
  const type = String(option.type ?? option.valueType ?? option.value_type ?? '').toLowerCase()
  if (type === 'boolean' || type === 'bool') return 'boolean'
  if (type === 'number' || type === 'integer' || type === 'float') return 'number'
  if (choices.length > 0 || type === 'select' || type === 'enum') return 'select'
  if (type === 'string' || type === 'text') return 'string'
  const value = extractConfigOptionValue(option)
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'string'
  return 'unknown'
}

export function normalizeConfigOption(option: ConfigOption): NormalizedConfigOption {
  const options = optionChoices(option)
  const currentValue = extractConfigOptionValue(option)
  return {
    id: optionId(option),
    label: String(option.label ?? option.name ?? option.title ?? option.id ?? option.key ?? '未命名选项'),
    type: optionType(option, options),
    currentValue: currentValue ?? '',
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
