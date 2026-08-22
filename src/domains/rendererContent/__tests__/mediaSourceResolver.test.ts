import { describe, expect, it } from 'vitest'
import {
  MAX_INLINE_BASE64_BYTES,
  isAllowedMediaUrl,
  resolveMediaSource,
} from '../mediaSourceResolver.ts'

/**
 * C03 RED：media source 解析契约。
 *
 * 卡面要求：
 * - URL 经协议白名单（https/http/data:image/audio/video/blob；javascript: 等拒绝）；
 * - 本地文件必须经注入的 host asset adapter，渲染层不做字符串猜测互转；
 * - base64 在 schema 限额内解析为 data: URL，超限拒绝；
 * - secret header 不写入 raw。
 */

describe('C03 mediaSourceResolver', () => {
  it('allows https and http URLs', () => {
    expect(isAllowedMediaUrl('https://example.com/pic.png')).toBe(true)
    expect(isAllowedMediaUrl('http://example.com/pic.png')).toBe(true)
  })

  it('rejects javascript:, data:text/html and unknown schemes', () => {
    expect(isAllowedMediaUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedMediaUrl('vbscript:x')).toBe(false)
    expect(isAllowedMediaUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false)
    expect(isAllowedMediaUrl('ftp://example.com/f.png')).toBe(false)
  })

  it('accepts data: URLs only for image/audio/video mime types within size limit', () => {
    expect(isAllowedMediaUrl('data:image/png;base64,iVBORw0K')).toBe(true)
    expect(isAllowedMediaUrl('data:audio/wav;base64,UklGRg==')).toBe(true)
    expect(isAllowedMediaUrl('data:video/mp4;base64,AAAA')).toBe(true)
    // 非 media mime 的 data: 一律拒绝
    const oversizeMime = `data:text/plain;base64,${'A'.repeat(16)}`
    expect(isAllowedMediaUrl(oversizeMime)).toBe(false)
    expect(isAllowedMediaUrl(`data:image/png;base64,${'A'.repeat(MAX_INLINE_BASE64_BYTES + 1)}`)).toBe(false)
  })

  it('converts inline base64 to data URL when within limit, records kind=base64', () => {
    const result = resolveMediaSource({ base64: 'iVBORw0KGgo=', mime: 'image/png' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toBe('data:image/png;base64,iVBORw0KGgo=')
      expect(result.sourceKind).toBe('base64')
    }
  })

  it('rejects oversized base64 beyond schema limit', () => {
    const huge = 'A'.repeat(MAX_INLINE_BASE64_BYTES + 1)
    const result = resolveMediaSource({ base64: huge, mime: 'image/png' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('超过')
    }
  })

  it('rejects invalid base64 payload', () => {
    const result = resolveMediaSource({ base64: 'not@@base64!!', mime: 'image/png' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('base64')
    }
  })

  it('routes local paths through the injected host asset adapter only', () => {
    const seen: string[] = []
    const adapter = (path: string) => {
      seen.push(path)
      return `asset://localhost/${encodeURIComponent(path)}`
    }
    const result = resolveMediaSource({ localPath: 'C:\\media\\clip.mp4' }, { convertLocalPath: adapter })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Windows 路径原样交给 adapter——不做字符串猜测互转
      expect(seen).toEqual(['C:\\media\\clip.mp4'])
      expect(result.source).toBe(`asset://localhost/${encodeURIComponent('C:\\media\\clip.mp4')}`)
      expect(result.sourceKind).toBe('local-path')
    }
  })

  it('fails closed when no adapter is available for a local path', () => {
    const result = resolveMediaSource({ localPath: '/home/demo/a.png' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('adapter')
    }
  })

  it('passes through whitelisted remote URLs unchanged with kind=url', () => {
    const result = resolveMediaSource({ url: 'https://cdn.example.com/a.png' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toBe('https://cdn.example.com/a.png')
      expect(result.sourceKind).toBe('url')
    }
  })

  it('rejects non-whitelisted URL schemes with reason', () => {
    const result = resolveMediaSource({ url: 'javascript:alert(1)' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('协议')
    }
  })

  it('keeps MAX_INLINE_BASE64_BYTES at the documented schema limit', () => {
    // 8 MiB：与 contentPartSchema DEFAULT_MAX_RAW_BYTES 同数量级的保守限额
    expect(MAX_INLINE_BASE64_BYTES).toBe(8 * 1024 * 1024)
  })
})
