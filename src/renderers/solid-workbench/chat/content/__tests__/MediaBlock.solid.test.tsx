// @vitest-environment jsdom
import { render } from '@solidjs/testing-library'
import { describe, expect, it, vi } from 'vitest'
import { SolidMediaBlock } from '../MediaBlock.solid.tsx'
import type { ContentPart } from '../../../../../domains/workbench/content/contentPartSchema.ts'

/**
 * C03 RED：SolidMediaBlock 契约。
 *
 * - image：placeholder → ready/error；点击 zoom（aria-pressed）；
 * - audio/video：原生 controls、autoplay=false；
 * - 加载失败保留 metadata + retry；
 * - transcript 独立呈现；
 * - 危险 URL（javascript:）不进入 DOM src。
 */

function media(part: ContentPart, props?: Partial<Parameters<typeof SolidMediaBlock>[0]>) {
  return render(() => <SolidMediaBlock part={part} {...props} />)
}

describe('C03 SolidMediaBlock', () => {
  it('renders remote image with lazy loading and alt text', () => {
    const result = media({ kind: 'image', source: 'https://cdn.example.com/a.png', alt: '架构图', mimeType: 'image/png' })
    const img = result.container.querySelector('img.term-media-img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('https://cdn.example.com/a.png')
    expect(img.getAttribute('alt')).toBe('架构图')
    expect(img.getAttribute('loading')).toBe('lazy')
  })

  it('toggles zoom on click with aria-pressed', async () => {
    const result = media({ kind: 'image', source: 'https://cdn.example.com/a.png', alt: '图' })
    const button = result.container.querySelector('button.term-media-image-button') as HTMLButtonElement
    expect(button.getAttribute('aria-pressed')).toBe('false')
    button.click()
    await Promise.resolve()
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  it('audio uses native controls without autoplay', () => {
    const result = media({ kind: 'audio', source: 'https://cdn.example.com/a.wav', mimeType: 'audio/wav' })
    const audio = result.container.querySelector('audio.term-media-element') as HTMLAudioElement
    expect(audio).not.toBeNull()
    expect(audio.hasAttribute('controls')).toBe(true)
    expect(audio.autoplay).toBe(false)
  })

  it('video uses native controls without autoplay and keeps poster', () => {
    const result = media({
      kind: 'video',
      source: 'https://cdn.example.com/v.mp4',
      poster: 'https://cdn.example.com/poster.jpg',
      mimeType: 'video/mp4',
    })
    const video = result.container.querySelector('video.term-media-element') as HTMLVideoElement
    expect(video).not.toBeNull()
    expect(video.hasAttribute('controls')).toBe(true)
    expect(video.autoplay).toBe(false)
    expect(video.getAttribute('poster')).toBe('https://cdn.example.com/poster.jpg')
  })

  it('shows error state with metadata and retry when source is rejected', async () => {
    const onError = vi.fn()
    const result = media(
      { kind: 'image', url: 'javascript:alert(1)', alt: '危险图' } as unknown as ContentPart,
      {},
    )
    // javascript: 被白名单拒绝——不得出现任何带该 src 的元素
    await Promise.resolve()
    expect(result.container.textContent).toContain('媒体无法加载')
    expect(result.container.textContent).not.toBe('')
    const dangerous = result.container.querySelector('[src="javascript:alert(1)"]')
    expect(dangerous).toBeNull()
    void onError
  })

  it('keeps dimensions and mime metadata in caption on load failure', () => {
    const result = media({
      kind: 'image',
      url: 'javascript:x',
      width: 640,
      height: 480,
      mimeType: 'image/png',
    } as unknown as ContentPart)
    expect(result.container.textContent).toContain('640×480')
    expect(result.container.textContent).toContain('image/png')
    expect(result.container.textContent).toContain('重试')
  })

  it('base64 inline renders as data URL within limit', () => {
    const result = media({ kind: 'image', base64: 'iVBORw0KGgo=', mimeType: 'image/png', alt: '内联图' } as unknown as ContentPart)
    const img = result.container.querySelector('img.term-media-img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  it('local path fails closed without adapter and explains reason', () => {
    const result = media({ kind: 'image', localPath: 'C:\\m\\a.png' } as unknown as ContentPart)
    expect(result.container.textContent).toContain('adapter')
    expect(result.container.querySelector('.term-file-action')).not.toBeNull()
  })

  it('local path converts through injected adapter', () => {
    const seen: string[] = []
    const result = media(
      { kind: 'image', localPath: '/home/m/b.png' } as unknown as ContentPart,
      { resolverOptions: { convertLocalPath: (path) => { seen.push(path); return `asset://x/${path}` } } },
    )
    const img = result.container.querySelector('img.term-media-img') as HTMLImageElement
    expect(seen).toEqual(['/home/m/b.png'])
    expect(img.getAttribute('src')).toBe('asset://x//home/m/b.png')
  })

  it('transcript renders as separate text block, not mixed into payload', () => {
    const result = media({
      kind: 'audio',
      source: 'https://cdn.example.com/a.wav',
      transcript: '这是转写文本',
      mimeType: 'audio/wav',
    })
    const transcript = result.container.querySelector('.term-media-transcript-body')
    expect(transcript?.textContent).toBe('这是转写文本')
    // 音频 src 不包含转写文本
    const audio = result.container.querySelector('audio') as HTMLAudioElement
    expect(audio.getAttribute('src')).not.toContain('转写')
  })

  it('non-media part renders nothing', () => {
    const result = media({ kind: 'text', text: '普通文本' })
    expect(result.container.querySelector('.term-media')).toBeNull()
  })

  it('open external action only appears for URL sources and goes through callback', async () => {
    const onOpenExternal = vi.fn()
    const result = media(
      { kind: 'image', source: 'https://cdn.example.com/a.png', alt: '' },
      { onOpenExternal },
    )
    const openButton = [...result.container.querySelectorAll('button')]
      .find(button => button.textContent === '打开外部链接') as HTMLButtonElement
    expect(openButton).toBeTruthy()
    await openButton.click()
    expect(onOpenExternal).toHaveBeenCalledWith('https://cdn.example.com/a.png')

    // base64 来源没有"打开外部链接"
    const local = media({ kind: 'image', base64: 'iVBORw0KGgo=', mimeType: 'image/png' } as unknown as ContentPart, { onOpenExternal })
    const localOpen = [...local.container.querySelectorAll('button')]
      .find(button => button.textContent === '打开外部链接')
    expect(localOpen).toBeUndefined()
  })
})
