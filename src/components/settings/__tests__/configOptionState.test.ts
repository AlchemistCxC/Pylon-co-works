// 迁移自 scripts/test-config-option-normalization.mts（P91 A1，零覆盖补齐）
// 并含 scripts/test-config-option-field-boundary.mts（P91 A1）的纯函数段；
// 该脚本的 ConfigOptionField.tsx 源码正则段下沉为同目录 ConfigOptionField.a11y.test.tsx（RTL 行为测试）。
import { describe, expect, it } from 'vitest'
import {
  normalizeConfigOption,
  normalizeConfigOptions,
  parseConfigNumberInput,
} from '../configOptionState.ts'

function normalized(option: Parameters<typeof normalizeConfigOption>[0]) {
  return normalizeConfigOption(option)
}

describe('configOptionState 协议别名归一（迁移自 test-config-option-normalization.mts）', () => {
  it('候选集合接受各协议拼写，保留第一个可用集合作为用户可选项', () => {
    expect(normalized({
      id: 'from-options',
      options: [
        { id: 'alpha', name: 'Alpha' },
        { value: 'beta', label: 'Beta' },
      ],
    }).options).toEqual([
      { id: 'alpha', label: 'Alpha' },
      { id: 'beta', label: 'Beta' },
    ])
    expect(normalized({ id: 'from-choices', choices: [{ name: 'named' }] }).options).toEqual([
      { id: 'named', label: 'named' },
    ])
    expect(normalized({ id: 'from-values', values: [{ value: 'value-id' }] }).options).toEqual([
      { id: 'value-id', label: 'value-id' },
    ])
    expect(normalized({ id: 'from-available', available: [{ label: 'label-id' }] }).options).toEqual([
      { id: 'label-id', label: 'label-id' },
    ])
    expect(normalized({ id: 'empty-candidates', options: [] }).options).toEqual([])
    expect(normalized({ id: 'missing-candidates' }).options).toEqual([])
  })

  it('currentValue 按协议别名优先级取值，false 与 0 是合法值不被回退替换', () => {
    expect(normalized({ id: 'current-value', currentValue: 'preferred', value: 'fallback' }).currentValue).toBe('preferred')
    expect(normalized({ id: 'value', value: 'from-value' }).currentValue).toBe('from-value')
    expect(normalized({ id: 'current', current: 'from-current' }).currentValue).toBe('from-current')
    expect(normalized({ id: 'selected', selected: 'from-selected' }).currentValue).toBe('from-selected')
    expect(normalized({ id: 'false', currentValue: false }).currentValue).toBe(false)
    expect(normalized({ id: 'zero', currentValue: 0 }).currentValue).toBe(0)
    expect(normalized({ id: 'empty' }).currentValue).toBe('')
  })

  it('显式 type 归一支持文档化的标量与 select 形式（含别名）', () => {
    expect(normalized({ id: 'flag', type: 'boolean', currentValue: false }).type).toBe('boolean')
    expect(normalized({ id: 'flag-alias', type: 'bool', currentValue: true }).type).toBe('boolean')
    expect(normalized({ id: 'count', type: 'number', currentValue: 2 }).type).toBe('number')
    expect(normalized({ id: 'count-alias', type: 'integer', currentValue: 2 }).type).toBe('number')
    expect(normalized({ id: 'text', type: 'string', currentValue: '' }).type).toBe('string')
    expect(normalized({ id: 'text-alias', type: 'text', currentValue: 'hello' }).type).toBe('string')
    expect(normalized({ id: 'choice', type: 'select', options: [] }).type).toBe('select')
    expect(normalized({ id: 'enum', type: 'enum', options: [{ id: 'one' }] }).type).toBe('select')
  })

  it('type 缺省或陌生时按值形状推断标量分类，否则保持 unknown', () => {
    expect(normalized({ id: 'inferred-boolean', current: true }).type).toBe('boolean')
    expect(normalized({ id: 'inferred-number', value: 1.5 }).type).toBe('number')
    expect(normalized({ id: 'inferred-string', selected: 'plain' }).type).toBe('string')
    expect(normalized({ id: 'unknown', type: 'future-type', currentValue: { raw: true } }).type).toBe('unknown')
    expect(normalized({ id: 'empty-unknown', type: 'future-type' }).type).toBe('unknown')
  })

  it('非法集合输入视为无配置项，非法条目不抛错也不泄漏非 option', () => {
    expect(normalizeConfigOptions(null)).toEqual([])
    expect(normalizeConfigOptions(undefined)).toEqual([])
    expect(normalizeConfigOptions({})).toEqual([])
    expect(normalizeConfigOptions([null, undefined, 1, 'bad', { id: 'valid' }]).map(option => option.id)).toEqual(['valid'])
  })
})

describe('configOptionState 归一化与数字输入边界（迁移自 test-config-option-field-boundary.mts 纯函数段）', () => {
  it('所有支持的可编辑 kind 归一化后仍可编辑', () => {
    expect(normalized({
      id: 'model',
      type: 'select',
      currentValue: 'sonnet',
      options: [{ id: 'sonnet', name: 'Sonnet' }],
    }).type).toBe('select')
    expect(normalized({ id: 'enabled', type: 'boolean', currentValue: false }).type).toBe('boolean')
    expect(normalized({ id: 'name', type: 'string', currentValue: '' }).type).toBe('string')
    expect(normalized({ id: 'temperature', type: 'number', currentValue: 0 }).type).toBe('number')
  })

  it('未知值保持 non-editable JSON 展示，不被强转为可编辑标量控件', () => {
    const unknown = normalized({ id: 'future', type: 'future-type', currentValue: { enabled: true, limit: 3 } })
    expect(unknown.type).toBe('unknown')
    expect(unknown.currentValue).toEqual({ enabled: true, limit: 3 })
  })

  it('数字编辑保留空态、拒绝非法/非有限文本，合法 0 仍提交为数值 0', () => {
    expect(parseConfigNumberInput('')).toBeUndefined()
    expect(parseConfigNumberInput('   ')).toBeUndefined()
    expect(parseConfigNumberInput('not-a-number')).toBeUndefined()
    expect(parseConfigNumberInput('Infinity')).toBeUndefined()
    expect(parseConfigNumberInput('0')).toBe(0)
    expect(parseConfigNumberInput('12.5')).toBe(12.5)
  })
})
