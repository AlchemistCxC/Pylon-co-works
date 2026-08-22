// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toRenderMessage, type Message } from '../../../../components/chat/messageTypes.ts'
import type { WorkbenchAppearanceSnapshot } from '../../../../domains/workbench/appearance.ts'
import { clearMarkdownRenderModelCache } from '../markdownRenderModel.ts'
import { SolidMessageRow } from '../MessageRow.solid.tsx'

const APPEARANCE: Pick<WorkbenchAppearanceSnapshot,
  'userName' | 'userPrefix' | 'userColor' | 'assistantDot' | 'assistantDotGlyph' | 'assistantDotImage'> = {
  userName: '',
  userPrefix: '❯',
  userColor: '#aabbcc',
  assistantDot: false,
  assistantDotGlyph: '●',
  assistantDotImage: '',
}

function row(message: Message, appearance = APPEARANCE) {
  return render(() => (
    <SolidMessageRow renderMessage={toRenderMessage(message)} appearance={appearance} />
  ))
}

afterEach(() => {
  cleanup()
  clearMarkdownRenderModelCache()
  vi.restoreAllMocks()
})

describe('SolidMessageRow', () => {
  it('渲染 user，并保持旧 class 与内联颜色 contract', () => {
    const result = row({ id: 'u1', role: 'user', sender: 'local:demo', content: '用户提问', time: 't' })
    expect(result.getByText('demo')).toBeTruthy()
    expect(result.getByText('用户提问')).toBeTruthy()
    expect(result.container.querySelector('.term-row-user')?.getAttribute('data-render-type')).toBe('user')
    expect((result.container.querySelector('.term-user-prefix') as HTMLElement).style.color).toBe('rgb(170, 187, 204)')
  })

  it('渲染 assistant dot glyph 与 image 两种结构', () => {
    const glyph = row(
      { id: 'a1', role: 'assistant', sender: 'peri', content: '带圆点', time: 't' },
      { ...APPEARANCE, assistantDot: true },
    )
    expect(glyph.container.querySelector('.term-assistant-dot')?.textContent).toBe('●')
    glyph.unmount()

    const image = row(
      { id: 'a2', role: 'assistant', sender: 'peri', content: '带图片', time: 't' },
      { ...APPEARANCE, assistantDot: true, assistantDotImage: '/dot.png' },
    )
    expect(image.container.querySelector('.term-assistant-dot-img')?.getAttribute('src')).toBe('/dot.png')
  })

  it('异步渲染 GFM Markdown，并拒绝 javascript 链接', async () => {
    const result = row({
      id: 'a3', role: 'assistant', sender: 'peri',
      content: '## 标题\n\n- 项目\n\n[安全](https://example.com) [危险](javascript:alert(1))', time: 't',
    })

    await waitFor(() => expect(result.getByRole('heading', { name: '标题' })).toBeTruthy())
    expect(result.getByText('项目').closest('li')).not.toBeNull()
    expect(result.getByRole('link', { name: '安全' }).getAttribute('rel')).toBe('noopener noreferrer')
    expect(result.container.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(result.getByText('危险').tagName).toBe('SPAN')
  })

  it('代码块复用旧 gutter DOM，并在高亮未完成时显示纯文本 fallback', async () => {
    const result = row({
      id: 'a4', role: 'assistant', sender: 'peri',
      content: '```unknown\nconst value = 1\nreturn value\n```', time: 't',
    })

    await waitFor(() => expect(result.container.querySelector('.term-code-block')).not.toBeNull())
    expect(result.container.querySelectorAll('.term-code-line')).toHaveLength(2)
    expect(result.container.textContent).toContain('const value = 1')
  })

  it('reasoning 展开后显示正文和完成时长（C01：duration 标签）', async () => {
    const result = row({
      id: 'r1', role: 'reasoning', sender: 'peri', content: '第一行\n第二行', time: 't',
      thoughtDurationMs: 2400,
    })
    // C01：label 从 chars 计数改为 duration 呈现
    const button = result.getByRole('button', { name: /Thought for 2\.4s/ })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    await fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    // 正文经 C00 MarkdownContent 异步渲染，等待出现
    await waitFor(() => {
      if (!result.container.textContent?.includes('第二行')) throw new Error('markdown not flushed')
    }, { timeout: 5000 })
  })

  it('system error 使用 alert 结构', () => {
    const result = row({ id: 'e1', role: 'assistant', sender: 'system', content: '后端错误', time: 't' })
    expect(result.getByRole('alert').textContent).toContain('后端错误')
    expect(result.container.querySelector('[data-render-type="error"]')).not.toBeNull()
  })
})
