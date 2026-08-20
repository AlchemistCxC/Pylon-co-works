import { describe, expect, it } from 'vitest'
import { formatRuntimeError } from '../runtimeError'

describe('formatRuntimeError（结构化错误展示）', () => {
  it('Error 对象取 message', () => {
    expect(formatRuntimeError('a', new Error('boom')).message).toBe('boom')
  })

  it('字符串错误原样展示', () => {
    expect(formatRuntimeError('a', 'db down').message).toBe('db down')
  })

  it('后端 wire 错误 {code,message} 提取结构化 code 与 message（不再拼前缀丢结构）', () => {
    expect(formatRuntimeError('删除会话记录', {
      code: 'user_data_unavailable',
      message: '用户数据仓库不可用：user data db unavailable',
    })).toEqual({
      action: '删除会话记录',
      code: 'user_data_unavailable',
      message: '用户数据仓库不可用：user data db unavailable',
      recovery: undefined,
    })
  })

  it('message 已含 code 时保留原样并同时提取 code', () => {
    expect(formatRuntimeError('a', {
      code: 'user_data_unavailable',
      message: 'user_data_unavailable: db down',
    })).toMatchObject({
      action: 'a',
      code: 'user_data_unavailable',
      message: 'user_data_unavailable: db down',
    })
  })

  it('无 message 的对象 / null / undefined / [object Object] 兜底为未知错误', () => {
    expect(formatRuntimeError('a', {}).message).toBe('未知错误')
    expect(formatRuntimeError('a', null).message).toBe('未知错误')
    expect(formatRuntimeError('a', undefined).message).toBe('未知错误')
    expect(formatRuntimeError('a', { code: 'x' }).message).toBe('未知错误')
  })
})
