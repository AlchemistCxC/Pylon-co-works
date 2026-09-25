import { useState } from 'react'

/**
 * ElicitationRequestCard — ACP elicitation/create（form 模式）表单卡（#316）。
 *
 * 官方契约要点：requestedSchema 是受限 JSON Schema（扁平 properties，原语
 * string/number/boolean/enum + default），客户端应预填默认值并允许用户修改后
 * 提交；form 模式不得用于索要密钥（后端/agent 侧责任）。三值应答：
 * accept（带 values）/ decline / cancel —— 经 respond_interaction 后端白名单
 * 原样进 wire content。
 *
 * 超出原语子集的 schema（object/array/无 type 属性）降级：卡片明示不支持，
 * 仅提供 拒绝/取消 —— 不猜测语义、不静默丢字段。
 * url 模式（payload 带 url）本期不支持：仅 拒绝/取消（不打开任何外部地址）。
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

const FIELD_ROW = 'flex items-center gap-2 mb-2'
const LABEL = 'flex-[0_0_110px] text-[12px] text-text-dim break-all'
const INPUT = 'flex-1 min-w-0 px-2 py-1 text-[13px] text-text bg-bg-input border border-border rounded-none focus-visible:outline-2 focus-visible:outline-accent'
const NOTICE = 'text-[12px] text-[var(--warning,#b8860b)] bg-bg-input border border-border rounded-none px-2 py-1.5 mb-2'
const URL_NOTICE = 'text-[12px] text-[var(--danger,#c0392b)] bg-bg-input border border-border rounded-none px-2 py-1.5 mb-2 break-all'

export default function ElicitationRequestCard(props: {
  request: {
    elicitMessage?: string
    requestedSchema?: Record<string, unknown>
    elicitUrl?: string
  }
  answering: boolean
  onSubmit: (values: ElicitationValues) => void
  onDecline: () => void
  onCancel: () => void
}) {
  const { request, answering, onSubmit, onDecline, onCancel } = props
  const parsed = request.requestedSchema
    ? parseElicitationFields(request.requestedSchema)
    : { fields: [], unsupported: false }
  const urlMode = typeof request.elicitUrl === 'string' && request.elicitUrl.length > 0
  const [raw, setRaw] = useState<Record<string, string | boolean>>(() => {
    const initial: Record<string, string | boolean> = {}
    for (const field of parsed.fields) {
      if (field.type === 'boolean') initial[field.name] = field.defaultValue === true
      else if (field.defaultValue !== undefined) initial[field.name] = String(field.defaultValue)
      else initial[field.name] = ''
    }
    return initial
  })
  const [missing, setMissing] = useState(false)

  const submit = () => {
    if (answering) return
    const values = collectElicitationValues(parsed.fields, raw)
    if (values === null) {
      setMissing(true)
      return
    }
    onSubmit(values)
  }

  return (
    <div>
      {urlMode && (
        <div className={URL_NOTICE} role="alert">
          该请求要求打开外部地址完成授权（{request.elicitUrl}）。当前版本不支持外部授权流程，可选择拒绝或取消。
        </div>
      )}
      {!urlMode && parsed.unsupported && (
        <div className={NOTICE}>该表单包含暂不支持的字段类型（对象/数组等），无法在本表单中填写；可选择拒绝或取消。</div>
      )}
      {!urlMode && !parsed.unsupported && parsed.fields.length === 0 && (
        <div className={NOTICE}>该请求不要求填写任何字段，可直接提交确认。</div>
      )}
      {parsed.fields.map(field => (
        <div className={FIELD_ROW} key={field.name}>
          <label className={LABEL} htmlFor={`elicit-${field.name}`}>
            {field.name}
            {field.required ? ' *' : ''}
            {field.description ? `（${field.description}）` : ''}
          </label>
          {field.type === 'boolean' ? (
            <input
              id={`elicit-${field.name}`}
              type="checkbox"
              className="accent-[var(--accent)]
              checked:bg-accent"
              checked={raw[field.name] === true}
              disabled={answering}
              onChange={event => setRaw(state => ({ ...state, [field.name]: event.target.checked }))}
            />
          ) : field.type === 'enum' ? (
            <select
              id={`elicit-${field.name}`}
              className={INPUT}
              value={String(raw[field.name] ?? '')}
              disabled={answering}
              onChange={event => setRaw(state => ({ ...state, [field.name]: event.target.value }))}
            >
              {(field.enumValues ?? []).map(value => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          ) : (
            <input
              id={`elicit-${field.name}`}
              type={field.type === 'number' ? 'text' : 'text'}
              inputMode={field.type === 'number' ? 'decimal' : undefined}
              className={INPUT}
              value={String(raw[field.name] ?? '')}
              disabled={answering}
              onChange={event => setRaw(state => ({ ...state, [field.name]: event.target.value }))}
            />
          )}
        </div>
      ))}
      {missing && (
        <div className="text-[12px] text-[var(--danger,#c0392b)] mb-2" role="alert">必填字段未填写或数字格式不正确。</div>
      )}
      <div className="flex flex-wrap gap-2">
        {!urlMode && !parsed.unsupported && (
          <button
            autoFocus
            type="button"
            className="flex-[1_1_auto] min-w-[96px] px-3 py-1.5 text-[13px] font-[family-name:var(--font)] text-text bg-bg-active border border-border rounded-none cursor-pointer enabled:hover:bg-bg-hover enabled:hover:border-border-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-[var(--state-disabled-opacity)] disabled:cursor-not-allowed"
            disabled={answering}
            onClick={submit}
          >提交</button>
        )}
        <button
          type="button"
          className="flex-[1_1_auto] min-w-[96px] px-3 py-1.5 text-[13px] font-[family-name:var(--font)] text-text bg-bg-active border border-border rounded-none cursor-pointer enabled:hover:bg-bg-hover enabled:hover:border-border-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-[var(--state-disabled-opacity)] disabled:cursor-not-allowed"
          disabled={answering}
          onClick={onDecline}
        >拒绝</button>
        <button
          type="button"
          className="flex-[0_0_auto] min-w-[60px] px-3 py-1.5 text-[13px] font-[family-name:var(--font)] text-text-dim bg-transparent border border-border rounded-none cursor-pointer hover:text-text hover:border-border-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={onCancel}
        >取消</button>
      </div>
    </div>
  )
}
