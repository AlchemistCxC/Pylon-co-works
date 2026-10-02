/**
 * elicitationSchema — ACP elicitation/create 受限 JSON Schema 的解析与值收集
 * （#316 契约；#515 自 ElicitationRequestCard.tsx 抽出为框架无关模块，供
 * React/Solid 两侧与测试共用——sessionSettingsForm.ts 同款先例）。
 *
 * 官方契约要点：requestedSchema 是受限 JSON Schema（扁平 properties，原语
 * string/number/boolean/enum + default）；超出原语子集降级 unsupported
 * （不支持即如实告知，不猜语义、不静默丢字段）。
 */

export interface ElicitationField {
  name: string
  type: 'string' | 'number' | 'boolean' | 'enum'
  enumValues?: string[]
  defaultValue?: string | number | boolean
  description?: string
  required: boolean
}

export interface ParsedElicitationSchema {
  fields: ElicitationField[]
  /** 存在超出原语子集的属性 → 整卡降级（不支持即如实告知，不猜语义） */
  unsupported: boolean
}

const SUPPORTED_TYPES = new Set(['string', 'number', 'boolean'])

/** 受限 JSON Schema → 表单字段（纯函数，供卡片与测试共用）。 */
export function parseElicitationFields(schema: unknown): ParsedElicitationSchema {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { fields: [], unsupported: true }
  }
  const object = schema as Record<string, unknown>
  const properties = typeof object.properties === 'object' && object.properties !== null && !Array.isArray(object.properties)
    ? (object.properties as Record<string, unknown>)
    : {}
  const required = Array.isArray(object.required)
    ? object.required.filter((name): name is string => typeof name === 'string')
    : []
  const fields: ElicitationField[] = []
  let unsupported = false
  for (const [name, raw] of Object.entries(properties)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      unsupported = true
      continue
    }
    const property = raw as Record<string, unknown>
    const type = typeof property.type === 'string' ? property.type : undefined
    const enumRaw = Array.isArray(property.enum) ? (property.enum as unknown[]) : undefined
    const enumValues = enumRaw
      ? enumRaw.filter((value): value is string => typeof value === 'string')
      : undefined
    if (enumValues && enumRaw && enumValues.length !== enumRaw.length) {
      // 非全字符串 enum：静默降级成自由文本会丢约束语义 → 按不支持处理
      // （#316 审查 P2-3）。
      unsupported = true
      continue
    }
    if (type === 'string' && enumValues && enumValues.length > 0) {
      fields.push({
        name,
        type: 'enum',
        enumValues,
        defaultValue: typeof property.default === 'string' ? property.default : enumValues[0],
        description: typeof property.description === 'string' ? property.description : undefined,
        required: required.includes(name),
      })
      continue
    }
    if (type !== undefined && SUPPORTED_TYPES.has(type)) {
      const defaultValue = property.default
      fields.push({
        name,
        type: type as 'string' | 'number' | 'boolean',
        defaultValue:
          typeof defaultValue === 'string' || typeof defaultValue === 'number' || typeof defaultValue === 'boolean'
            ? defaultValue
            : undefined,
        description: typeof property.description === 'string' ? property.description : undefined,
        required: required.includes(name),
      })
      continue
    }
    // object/array/未知 type：超出原语子集。
    unsupported = true
  }
  return { fields, unsupported }
}

export type ElicitationValues = Record<string, string | number | boolean>

/** 校验并收集表单值；required 缺失返回 null（由卡片提示，不猜测语义）。 */
export function collectElicitationValues(fields: ElicitationField[], raw: Record<string, string | boolean>): ElicitationValues | null {
  const values: ElicitationValues = {}
  for (const field of fields) {
    const value = raw[field.name]
    if (field.type === 'boolean') {
      values[field.name] = value === true
      continue
    }
    const text = typeof value === 'string' ? value : ''
    if (text.trim() === '') {
      if (field.required) return null
      continue
    }
    if (field.type === 'number') {
      const parsed = Number(text)
      if (Number.isNaN(parsed)) return null
      values[field.name] = parsed
      continue
    }
    values[field.name] = text
  }
  return values
}
