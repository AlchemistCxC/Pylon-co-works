import { describe, expect, it } from 'vitest'
import { errorCode, errorMessage } from '../errorPayload.ts'

describe('errorMessage（#172 结构化拒绝 DTO 归一化）', () => {
  it('结构化对象取 message 字段，保留后端原文', () => {
    expect(errorMessage({ code: 'Acp', message: 'session_new_before_initialize: …' }))
      .toBe('session_new_before_initialize: …')
  })

  it('Error 实例取 message，纯字符串原样返回', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain failure')).toBe('plain failure')
  })

  it('裸对象（无 message）不再渲染成 [object Object]，回退 fallback', () => {
    expect(errorMessage({ code: 'NoActiveAgent' }, '创建失败')).toBe('创建失败')
    expect(errorMessage('[object Object]')).toBe('')
  })

  it('null / undefined / 空 message 回退 fallback（契约：提取不到可读文本即回退）', () => {
    expect(errorMessage(null, '创建失败')).toBe('创建失败')
    expect(errorMessage(undefined, '创建失败')).toBe('创建失败')
    expect(errorMessage({ code: 'Acp', message: '' }, '创建失败')).toBe('创建失败')
    expect(errorMessage(new Error(''), '重试失败')).toBe('重试失败')
  })

  it('数字等可读原始值走 String()，不误伤', () => {
    expect(errorMessage(42)).toBe('42')
  })
})

describe('errorCode（#172 结构化 code 读取）', () => {
  it('读取结构化拒绝 DTO 的 code，供错误中心分类', () => {
    expect(errorCode({ code: 'NoActiveAgent', message: '…' })).toBe('NoActiveAgent')
  })

  it('非该形状返回 null：无 code、非字符串 code、空 code、Error 实例、null', () => {
    expect(errorCode({ message: '…' })).toBeNull()
    expect(errorCode({ code: 123 })).toBeNull()
    expect(errorCode({ code: '' })).toBeNull()
    expect(errorCode(new Error('boom'))).toBeNull()
    expect(errorCode(null)).toBeNull()
    expect(errorCode(undefined)).toBeNull()
  })
})
