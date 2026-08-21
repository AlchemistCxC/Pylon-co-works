/**
 * Serializable settings contract owned by the renderer catalog.
 *
 * This module deliberately contains no React/Solid/store imports.  A plugin
 * contributes data; the host validates it once and every settings surface
 * consumes the same frozen representation.
 */

export type ChoicePresentation = 'select' | 'radio' | 'segmented'
export type MultiChoicePresentation = 'checklist' | 'listbox'
export type ColorPresentation = 'palette' | 'picker' | 'palette+picker'
export type NumberPresentation = 'slider' | 'input' | 'slider+input'

export type RendererSettingValue = null | boolean | number | string | readonly RendererSettingValue[] | {
  readonly [key: string]: RendererSettingValue
}

export interface RendererSettingOption {
  readonly value: string
  readonly label?: string
  readonly description?: string
  readonly disabled?: boolean
  readonly order?: number
}

export type RenderSettingCondition =
  | { readonly equals: { readonly field: string; readonly value: RendererSettingValue } }
  | { readonly oneOf: { readonly field: string; readonly values: readonly RendererSettingValue[] } }
  | { readonly not: RenderSettingCondition }
  | { readonly all: readonly RenderSettingCondition[] }
  | { readonly any: readonly RenderSettingCondition[] }

interface RenderSettingFieldBase {
  /** `key` is the canonical name; `id` is accepted as a migration alias. */
  readonly key?: string
  readonly id?: string
  readonly label?: string
  readonly description?: string
  readonly advanced?: boolean
  readonly default?: RendererSettingValue
  readonly showIf?: RenderSettingCondition
  readonly resetLabel?: string
}

export interface RenderChoiceSettingField extends RenderSettingFieldBase {
  readonly type: 'choice'
  readonly presentation: ChoicePresentation
  readonly options: readonly RendererSettingOption[]
  readonly optionTarget?: string
}

export interface RenderMultiChoiceSettingField extends RenderSettingFieldBase {
  readonly type: 'multi-choice'
  readonly presentation: MultiChoicePresentation
  readonly options: readonly RendererSettingOption[]
  readonly minSelected?: number
  readonly maxSelected?: number
  readonly optionTarget?: string
}

export interface RenderColorSettingField extends RenderSettingFieldBase {
  readonly type: 'color'
  readonly presentation: ColorPresentation
  readonly alpha?: boolean
  readonly paletteTarget?: string
}

export interface RenderNumberSettingField extends RenderSettingFieldBase {
  readonly type: 'number'
  readonly presentation: NumberPresentation
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly unit?: string
}

export interface RenderBooleanSettingField extends RenderSettingFieldBase {
  readonly type: 'boolean'
  readonly presentation: 'toggle' | 'checkbox'
}

export interface RenderTextSettingField extends RenderSettingFieldBase {
  readonly type: 'text'
  readonly presentation: 'input' | 'textarea'
  readonly pattern?: string
  readonly placeholder?: string
  readonly maxLength?: number
}

export type RenderSettingField =
  | RenderChoiceSettingField
  | RenderMultiChoiceSettingField
  | RenderColorSettingField
  | RenderNumberSettingField
  | RenderBooleanSettingField
  | RenderTextSettingField

export interface RenderSettingGroup {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly layout?: 'stack' | 'grid' | 'inline' | 'tabs'
  readonly collapsedByDefault?: boolean
  readonly fields: readonly RenderSettingField[]
}

export interface RendererSettingsSchema {
  readonly schemaVersion: number
  readonly groups: readonly RenderSettingGroup[]
}

const OPTION_TARGET_PATTERN = /^(kind|suite|slot)\.[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+$/

function fail(message: string): never {
  throw new Error(`Renderer settings schema 无效：${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSerializable(value: unknown, seen = new Set<unknown>()): value is RendererSettingValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.every(item => isSerializable(item, seen))
  return Object.values(value).every(item => isSerializable(item, seen))
}

function fieldKey(field: RenderSettingField): string {
  const key = field.key ?? field.id
  if (!key || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key)) fail(`field key 非法：${String(key)}`)
  return key
}

function validateCondition(condition: RenderSettingCondition, fields: ReadonlySet<string>): void {
  if (!isRecord(condition)) fail('showIf 必须是可序列化 condition')
  if ('equals' in condition) {
    const item = condition.equals
    if (!isRecord(item) || typeof item.field !== 'string' || !fields.has(item.field) || !isSerializable(item.value)) fail(`showIf equals 引用非法字段：${String((item as Record<string, unknown>)?.field)}`)
    return
  }
  if ('oneOf' in condition) {
    const item = condition.oneOf
    if (!isRecord(item) || typeof item.field !== 'string' || !fields.has(item.field) || !Array.isArray(item.values) || item.values.length === 0 || !item.values.every(value => isSerializable(value))) fail(`showIf oneOf 引用非法字段：${String((item as Record<string, unknown>)?.field)}`)
    return
  }
  if ('not' in condition) {
    validateCondition(condition.not, fields)
    return
  }
  if ('all' in condition || 'any' in condition) {
    const list = 'all' in condition ? condition.all : condition.any
    if (!Array.isArray(list) || list.length === 0) fail('showIf all/any 不能为空')
    list.forEach(item => validateCondition(item, fields))
    return
  }
  fail('showIf condition 类型未知')
}

function validateOptions(fieldKeyValue: string, options: readonly RendererSettingOption[], defaultValue: RendererSettingValue | undefined, target?: string): void {
  if (!Array.isArray(options) || options.length === 0) fail(`${fieldKeyValue} options 不能为空`)
  const values = new Set<string>()
  for (const option of options) {
    if (!isRecord(option) || typeof option.value !== 'string' || !option.value.trim()) fail(`${fieldKeyValue} option value 非法`)
    if (values.has(option.value)) fail(`${fieldKeyValue} option 重复：${option.value}`)
    values.add(option.value)
    if (option.label !== undefined && (typeof option.label !== 'string' || !option.label.trim())) fail(`${fieldKeyValue} option label 非法`)
    if (option.order !== undefined && (typeof option.order !== 'number' || !Number.isFinite(option.order))) fail(`${fieldKeyValue} option order 非法`)
  }
  if (target !== undefined && !OPTION_TARGET_PATTERN.test(target)) fail(`${fieldKeyValue} optionTarget 非法：${target}`)
  if (defaultValue !== undefined && !values.has(String(defaultValue))) fail(`${fieldKeyValue} default 不在 options 中`)
}

function validateField(field: RenderSettingField, fields: ReadonlySet<string>): void {
  const key = fieldKey(field)
  if (field.label !== undefined && !field.label.trim()) fail(`${key} label 不能为空`)
  if (field.description !== undefined && typeof field.description !== 'string') fail(`${key} description 非法`)
  if (field.default !== undefined && !isSerializable(field.default)) fail(`${key} default 必须可序列化`)
  if (field.showIf) validateCondition(field.showIf, fields)
  switch (field.type) {
    case 'choice':
      validateOptions(key, field.options, field.default, field.optionTarget)
      if (!['select', 'radio', 'segmented'].includes(field.presentation)) fail(`${key} choice presentation 非法`)
      if (field.default !== undefined && typeof field.default !== 'string') fail(`${key} choice default 必须是 string`)
      return
    case 'multi-choice': {
      validateOptions(key, field.options, undefined, field.optionTarget)
      const values = new Set(field.options.map(option => option.value))
      if (field.minSelected !== undefined && (!Number.isInteger(field.minSelected) || field.minSelected < 0)) fail(`${key} minSelected 非法`)
      if (field.maxSelected !== undefined && (!Number.isInteger(field.maxSelected) || field.maxSelected < 0)) fail(`${key} maxSelected 非法`)
      if (field.minSelected !== undefined && field.maxSelected !== undefined && field.minSelected > field.maxSelected) fail(`${key} minSelected 大于 maxSelected`)
      if (field.maxSelected !== undefined && field.maxSelected > field.options.length) fail(`${key} maxSelected 超出 options`)
      if (field.default !== undefined && (!Array.isArray(field.default) || !field.default.every(value => typeof value === 'string' && values.has(value)))) fail(`${key} multi-choice default 非法`)
      return
    }
    case 'color':
      if (!['palette', 'picker', 'palette+picker'].includes(field.presentation)) fail(`${key} color presentation 非法`)
      if (field.paletteTarget !== undefined && !OPTION_TARGET_PATTERN.test(field.paletteTarget)) fail(`${key} paletteTarget 非法：${field.paletteTarget}`)
      if (field.default !== undefined && typeof field.default !== 'string') fail(`${key} color default 必须是 string`)
      return
    case 'number':
      if (!['slider', 'input', 'slider+input'].includes(field.presentation)) fail(`${key} number presentation 非法`)
      if (field.min !== undefined && !Number.isFinite(field.min)) fail(`${key} min 非法`)
      if (field.max !== undefined && !Number.isFinite(field.max)) fail(`${key} max 非法`)
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) fail(`${key} min 大于 max`)
      if (field.step !== undefined && (!Number.isFinite(field.step) || field.step <= 0)) fail(`${key} step 非法`)
      if (field.default !== undefined && (typeof field.default !== 'number' || (field.min !== undefined && field.default < field.min) || (field.max !== undefined && field.default > field.max))) fail(`${key} number default 超出范围`)
      return
    case 'boolean':
      if (field.default !== undefined && typeof field.default !== 'boolean') fail(`${key} boolean default 非法`)
      return
    case 'text':
      if (!['input', 'textarea'].includes(field.presentation)) fail(`${key} text presentation 非法`)
      if (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || field.maxLength < 0)) fail(`${key} maxLength 非法`)
      if (field.pattern !== undefined) {
        try { new RegExp(field.pattern) } catch { fail(`${key} pattern 非法`) }
      }
      if (field.default !== undefined && typeof field.default !== 'string') fail(`${key} text default 必须是 string`)
      return
    default:
      fail(`${key} type 未知`)
  }
}

export function validateRendererSettingsSchema(schema: RendererSettingsSchema): void {
  if (!isRecord(schema) || !Number.isInteger(schema.schemaVersion) || schema.schemaVersion < 1) fail('schemaVersion 必须是正整数')
  if (!Array.isArray(schema.groups)) fail('groups 必须是数组')
  const groups = new Set<string>()
  const fields = new Set<string>()
  for (const group of schema.groups) {
    if (!isRecord(group) || typeof group.id !== 'string' || !group.id.trim()) fail('group id 非法')
    if (groups.has(group.id)) fail(`group id 重复：${group.id}`)
    groups.add(group.id)
    if (typeof group.label !== 'string' || !group.label.trim()) fail(`group label 非法：${group.id}`)
    if (!Array.isArray(group.fields)) fail(`group fields 非法：${group.id}`)
    for (const field of group.fields) {
      const key = fieldKey(field)
      if (fields.has(key)) fail(`field key 重复：${key}`)
      fields.add(key)
    }
  }
  for (const group of schema.groups) for (const field of group.fields) validateField(field, fields)
}

function freeze(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) value.forEach(item => freeze(item, seen))
  else Object.values(value).forEach(item => freeze(item, seen))
  return Object.freeze(value)
}

export function normalizeRendererSettingsSchema(schema: RendererSettingsSchema): RendererSettingsSchema {
  validateRendererSettingsSchema(schema)
  const copy = structuredClone(schema) as RendererSettingsSchema
  return freeze(copy) as RendererSettingsSchema
}

export function settingFieldKey(field: Pick<RenderSettingField, 'key' | 'id'>): string {
  return field.key ?? field.id ?? ''
}

export function settingOptionTarget(fieldNamespace: 'kind' | 'suite' | 'slot', ownerId: string, fieldKeyValue: string): string {
  const target = `${fieldNamespace}.${ownerId}.${fieldKeyValue}`
  if (!OPTION_TARGET_PATTERN.test(target)) fail(`setting option target 非法：${target}`)
  return target
}
