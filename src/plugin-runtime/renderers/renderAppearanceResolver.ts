import type {
  RenderSettingField,
  RendererSettingValue,
  RendererSettingsSchema,
} from './rendererSettingsTypes.ts'
import { settingFieldKey } from './rendererSettingsTypes.ts'

export type RenderAppearanceSource = 'schema-default' | 'host-default' | 'kind-default' | 'profile' | 'user-override' | 'session-preview'

export interface RenderAppearanceResolveInput {
  readonly schema: RendererSettingsSchema
  readonly hostDefaults?: Readonly<Record<string, RendererSettingValue>>
  readonly kindDefaults?: Readonly<Record<string, RendererSettingValue>>
  readonly profileTokens?: Readonly<Record<string, RendererSettingValue>>
  readonly userOverrides?: Readonly<Record<string, RendererSettingValue>>
  readonly sessionPreview?: Readonly<Record<string, RendererSettingValue>>
  /** Current plugin-contributed options; absent means schema options are authoritative. */
  readonly availableOptions?: Readonly<Record<string, readonly string[]>>
}

export interface RenderAppearanceDiagnostic {
  readonly code: 'renderer.setting.invalid' | 'renderer.setting.unavailable'
  readonly key: string
  readonly message: string
  readonly source: RenderAppearanceSource | 'unknown'
}

export interface RenderAppearanceResolution {
  readonly values: Readonly<Record<string, RendererSettingValue>>
  readonly sources: Readonly<Record<string, RenderAppearanceSource>>
  readonly unavailable: Readonly<Record<string, RendererSettingValue>>
  readonly diagnostics: readonly RenderAppearanceDiagnostic[]
}

function fieldsOf(schema: RendererSettingsSchema): Map<string, RenderSettingField> {
  return new Map(schema.groups.flatMap(group => group.fields.map(field => [settingFieldKey(field), field] as const)))
}

function validValue(field: RenderSettingField, value: RendererSettingValue, available?: readonly string[]): boolean {
  switch (field.type) {
    case 'choice':
      return typeof value === 'string' && field.options.some(option => option.value === value) && (available === undefined || available.includes(value))
    case 'multi-choice': {
      if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return false
      const options = new Set(field.options.map(option => option.value))
      if (!value.every(item => options.has(item) && (available === undefined || available.includes(item)))) return false
      return (field.minSelected === undefined || value.length >= field.minSelected) && (field.maxSelected === undefined || value.length <= field.maxSelected)
    }
    case 'color':
      return typeof value === 'string' && value.trim().length > 0
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max)
    case 'boolean':
      return typeof value === 'boolean'
    case 'text':
      if (typeof value !== 'string' || (field.maxLength !== undefined && value.length > field.maxLength)) return false
      if (field.pattern !== undefined) {
        try { if (!new RegExp(field.pattern).test(value)) return false } catch { return false }
      }
      return true
  }
}

function optionUnavailable(field: RenderSettingField, value: RendererSettingValue, available?: readonly string[]): boolean {
  if (!available) return false
  if (field.type === 'choice') return typeof value === 'string' && field.options.some(option => option.value === value) && !available.includes(value)
  if (field.type === 'multi-choice' && Array.isArray(value)) return value.some(item => typeof item === 'string' && !available.includes(item))
  return false
}

export function resolveRenderAppearance(input: RenderAppearanceResolveInput): RenderAppearanceResolution {
  const fields = fieldsOf(input.schema)
  const values: Record<string, RendererSettingValue> = {}
  const sources: Record<string, RenderAppearanceSource> = {}
  const unavailable: Record<string, RendererSettingValue> = {}
  const diagnostics: RenderAppearanceDiagnostic[] = []
  const layers: readonly [RenderAppearanceSource, Readonly<Record<string, RendererSettingValue>> | undefined][] = [
    ['schema-default', Object.fromEntries([...fields].flatMap(([key, field]) => field.default === undefined ? [] : [[key, field.default]]))],
    ['host-default', input.hostDefaults],
    ['kind-default', input.kindDefaults],
    ['profile', input.profileTokens],
    ['user-override', input.userOverrides],
    ['session-preview', input.sessionPreview],
  ]
  for (const [source, layer] of layers) {
    if (!layer) continue
    for (const [key, value] of Object.entries(layer)) {
      const field = fields.get(key)
      if (!field) {
        if (source === 'user-override' || source === 'session-preview') {
          unavailable[key] = value
          diagnostics.push({ code: 'renderer.setting.unavailable', key, message: `设置字段 ${key} 当前不可用，已保留原值`, source })
        }
        continue
      }
      if (!validValue(field, value, input.availableOptions?.[key])) {
        if (source === 'user-override' || source === 'session-preview') {
          if (optionUnavailable(field, value, input.availableOptions?.[key])) {
            unavailable[key] = value
            diagnostics.push({ code: 'renderer.setting.unavailable', key, message: `设置字段 ${key} 的候选项已卸载，已保留原值`, source })
          } else {
            diagnostics.push({ code: 'renderer.setting.invalid', key, message: `设置字段 ${key} 的 ${source} 值无效，已回退`, source })
          }
        }
        continue
      }
      values[key] = value
      sources[key] = source
    }
  }
  return Object.freeze({
    values: Object.freeze(values),
    sources: Object.freeze(sources),
    unavailable: Object.freeze(unavailable),
    diagnostics: Object.freeze(diagnostics.map(item => Object.freeze(item))),
  })
}

/** Named facade retained for callers that prefer an object-oriented resolver. */
export class RenderAppearanceResolver {
  resolve(input: RenderAppearanceResolveInput): RenderAppearanceResolution {
    return resolveRenderAppearance(input)
  }
}

export const resolveRendererAppearance = resolveRenderAppearance
