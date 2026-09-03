import { describe, expect, it } from 'vitest'
import { formatRuntimeError, reportRuntimeError } from '../runtimeError'

describe('formatRuntimeError（结构化错误展示）', () => {
  it('Error 对象取 message', () => {
    expect(formatRuntimeError('a', new Error('boom')).message).toBe('boom')
  })

  it('Error 的稳定 code 进入结构化 detail', () => {
    const error = Object.assign(new Error('连接失败'), { code: 'agent_connection_timeout' })
    expect(formatRuntimeError('连接', error)).toMatchObject({
      message: '连接失败', code: 'agent_connection_timeout',
    })
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

  it('技术详情有限长度并脱敏明显凭据字段', () => {
    const error = { message: 'transport failed', token: 'secret-token', nested: { authorization: 'Bearer secret' }, body: 'x'.repeat(20_000) }
    const original = console.error
    console.error = () => {}
    try {
      const detail = reportRuntimeError('请求', error)
      expect(detail.message).toBe('transport failed')
      expect(detail.technicalMessage?.length).toBeLessThanOrEqual(8_220)
      expect(detail.technicalMessage).toContain('已脱敏')
      expect(detail.technicalMessage).not.toContain('secret-token')
    } finally {
      console.error = original
    }
  })

  it('未知对象的技术详情可处理循环引用且不抛异常', () => {
    const cyclic: Record<string, unknown> = { message: '循环错误', token: 'secret' }
    cyclic.self = cyclic
    const original = console.error
    console.error = () => {}
    try {
      const detail = reportRuntimeError('请求', cyclic)
      expect(detail.message).toBe('循环错误')
    } finally {
      console.error = original
    }
  })

  it('Error message 与 stack 中内插的凭据不会进入摘要或技术详情', () => {
    const error = new Error('request failed token=summary-secret')
    error.stack = [
      error.message,
      'Authorization: Bearer header-secret',
      'at https://user:basic-secret@example.test/path?api_key=query-secret',
    ].join('\n')
    const original = console.error
    console.error = () => {}
    try {
      const detail = reportRuntimeError('请求', error)
      expect(detail.message).toContain('token=[已脱敏]')
      expect(detail.technicalMessage).toContain('Bearer [已脱敏]')
      expect(detail.technicalMessage).toContain('api_key=[已脱敏]')
      expect(detail.technicalMessage).not.toMatch(/summary-secret|header-secret|basic-secret|query-secret/)
    } finally {
      console.error = original
    }
  })

  it('保留流式失败对象携带的 provider technicalMessage 供展开查看', () => {
    const error = Object.assign(new Error('Provider 返回错误'), {
      technicalMessage: 'ACP protocol: timed out after 180s (provider error)',
    })
    const original = console.error
    console.error = () => {}
    try {
      const detail = reportRuntimeError('发送消息', error)
      expect(detail.message).toBe('Provider 返回错误')
      expect(detail.technicalMessage).toContain('timed out after 180s')
    } finally {
      console.error = original
    }
  })

  it('裸 ACP provider timeout 文案不把配置的 180s 冒充实际处理耗时', () => {
    const original = console.error
    console.error = () => {}
    try {
      const detail = reportRuntimeError('发送消息', 'ACP protocol: timed out after 180s (provider error)')
      expect(detail.message).toBe('Provider 返回错误')
      expect(detail.message).not.toContain('180s')
      expect(detail.technicalMessage).toContain('180s')
    } finally {
      console.error = original
    }
  })
})
