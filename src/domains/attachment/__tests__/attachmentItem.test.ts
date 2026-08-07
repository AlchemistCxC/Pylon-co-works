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
