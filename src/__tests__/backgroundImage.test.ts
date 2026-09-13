// 迁移自 scripts/test-background-image.mts（P91 A1）；hasTauriRuntime 部分落位至 infrastructure/tauri/__tests__/env.test.ts。
import { describe, expect, it } from 'vitest'
import { resolveBackgroundImage } from '../backgroundImage.ts'

describe('resolveBackgroundImage — URL/路径解析（迁移自 scripts/test-background-image.mts，P91 A1）', () => {
  it('空值 → source null + cssValue none + 无错误', () => {
    expect(resolveBackgroundImage('')).toEqual({ source: null, cssValue: 'none', error: null })
  })

  it.each([
    'https://example.com/background image.png',
    'data:image/png;base64,AAAA',
    'blob:https://example.com/asset-id',
  ])('Web URL 原样透传不转换：%s', (source) => {
    const result = resolveBackgroundImage(source, () => { throw new Error('不应转换 Web URL') })
    expect(result.source).toBe(source)
    expect(result.cssValue).toBe(`url(${JSON.stringify(source)})`)
    expect(result.error).toBeNull()
  })

  it('本地 Windows 路径经转换器转为 asset URL', () => {
    let convertedPath = ''
    const local = resolveBackgroundImage('C:\\Users\\Alice\\Pictures\\background image.png', path => {
      convertedPath = path
      return 'http://asset.localhost/C%3A%5CUsers%5CAlice%5CPictures%5Cbackground%20image.png'
    })
    expect(convertedPath).toBe('C:\\Users\\Alice\\Pictures\\background image.png')
    expect(local.source).toBe('http://asset.localhost/C%3A%5CUsers%5CAlice%5CPictures%5Cbackground%20image.png')
    expect(local.cssValue).toBe('url("http://asset.localhost/C%3A%5CUsers%5CAlice%5CPictures%5Cbackground%20image.png")')
    expect(local.error).toBeNull()
  })

  it('转换失败 → source null + cssValue none + 错误消息', () => {
    const failed = resolveBackgroundImage('C:\\missing image.png', () => { throw new Error('转换失败') })
    expect(failed.source).toBeNull()
    expect(failed.cssValue).toBe('none')
    expect(failed.error).toBe('转换失败')
  })
})
