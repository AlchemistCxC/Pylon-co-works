/**
 * attachmentItem 行为测试（报告 7B / FE-AUD-019）：
 * kind 推断、创建、校验（重复/未知类型）、状态迁移。
 */
import { describe, expect, it } from 'vitest'
import { createAttachment, resolveAttachmentKind, validateAttachment, toSending } from '../attachmentItem'

describe('resolveAttachmentKind', () => {
  it('按扩展名推断 image/text/unknown', () => {
    expect(resolveAttachmentKind('a.png')).toBe('image')
    expect(resolveAttachmentKind('note.md')).toBe('text')
    expect(resolveAttachmentKind('archive.zip')).toBe('unknown')
  })
})

describe('createAttachment', () => {
  it('初始 validating 且 id 唯一', () => {
    const a = createAttachment('/a.png', 'a.png')
    expect(a.status).toBe('validating')
    expect(a.kind).toBe('image')
    expect(a.id.length).toBeGreaterThan(0)
  })
})

describe('validateAttachment', () => {
  it('重复路径拒绝', () => {
    const a = createAttachment('/a.png', 'a.png')
    expect(validateAttachment(a, { existingPaths: new Set(['/a.png']) })).toEqual({ ok: false, error: '该文件已在附件列表' })
    expect(validateAttachment(a, { existingPaths: new Set() }).ok).toBe(true)
  })

  it('未知类型拒绝', () => {
    const a = createAttachment('/x.zip', 'x.zip')
    const result = validateAttachment(a, { existingPaths: new Set() })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('不支持')
  })
})

describe('toSending', () => {
  it('ready → sending；error 保持 error', () => {
    const ready = createAttachment('/a.png', 'a.png')
    expect(toSending(ready).status).toBe('sending')
    const failed = { ...ready, status: 'error' as const, error: 'read failed' }
    expect(toSending(failed)).toEqual(failed)
  })
})

// ── ISSUE-15 W4 RED fixtures：AttachmentValidationOptions.maxBytes 落地（修复前必须失败）──
// 当前 validateAttachment 不读取 maxBytes、createAttachment 无 sizeBytes 参数；
// 以下用例按目标 API 形态断言（编译期 RED → 实现后 GREEN）。

describe('validateAttachment maxBytes（ISSUE-15 W4）', () => {
  it('超限拒绝并给出可见错误（进入发送队列前拒绝）', () => {
    const a = createAttachment('/big.png', 'big.png', 1024 * 1024)
    const result = validateAttachment(a, { existingPaths: new Set(), maxBytes: 1024 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('大小')
  })

  it('未超限通过', () => {
    const a = createAttachment('/ok.png', 'ok.png', 512)
    expect(validateAttachment(a, { existingPaths: new Set(), maxBytes: 1024 }).ok).toBe(true)
  })

  it('未设 maxBytes 时跳过大小校验（兼容既有调用）', () => {
    const a = createAttachment('/big.png', 'big.png', 10 * 1024 * 1024)
    expect(validateAttachment(a, { existingPaths: new Set() }).ok).toBe(true)
  })

  it('无 sizeBytes 信息时跳过大小校验（旧创建路径不误伤）', () => {
    const a = createAttachment('/old.png', 'old.png')
    expect(validateAttachment(a, { existingPaths: new Set(), maxBytes: 100 }).ok).toBe(true)
  })
})
