// @vitest-environment jsdom
import { describe, expect, test } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { AssistantContent, MessageRow } from '../ChatView'
import { useStore } from '../../../store'
import type { Message } from '../messageTypes'
import { useInterfaceModeStore } from '../../../domains/interface/interfaceModeStore'

function row(message: Message, type: 'assistant' | 'user' | 'reasoning' = 'assistant') {
  return render(
    <MessageRow
      renderMessage={{ type, message } as never}
      reduceMotion
      isStatic
    />,
  )
}

describe('MessageRow', () => {
  test('纯文本 assistant 消息渲染内容', () => {
    row({ id: 'm1', role: 'assistant', sender: 'peri', content: '这是回复内容', time: 't' })
    expect(screen.getByText('这是回复内容')).toBeTruthy()
  })

  test('assistant 纯文本保留首尾空行与内部空行', () => {
    const content = '\n第一行\n\n第二行\n'
    const { container } = render(<AssistantContent text={content} />)
    expect(container.querySelector('.term-plain-text')?.textContent).toBe(content)
  })

  test('assistant Markdown 诗歌在异步解析后保留段落和软换行', async () => {
    const content = '**星河**\n\n春风拂过山岗\n月光落在窗\n\n我把远方写进诗行'
    const { container } = render(<AssistantContent text={content} />)
    const { findByText } = within(container)
    await findByText('星河')
    const paragraphs = [...container.querySelectorAll('.term-assistant p')]
    expect(paragraphs.length).toBeGreaterThanOrEqual(2)
    expect(paragraphs.every(paragraph => paragraph.classList.contains('term-p'))).toBe(true)
    expect(paragraphs.some(paragraph => paragraph.textContent?.includes('春风拂过山岗\n月光落在窗'))).toBe(true)
  })

  test('assistantDot 开启时渲染圆点', () => {
    useInterfaceModeStore.setState({ interfaceMode: 'terminal-like' })
    useStore.setState({ assistantDot: true, assistantDotGlyph: '●' })
    const { container } = row({ id: 'm2', role: 'assistant', sender: 'peri', content: '带圆点', time: 't' })
    expect(container.querySelector('.term-assistant-dot')).not.toBeNull()
    expect(container.querySelector('.term-assistant-dot')?.textContent).toBe('●')
  })

  test('Modern GUI 使用语义化机器人图标替代终端字符', () => {
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
    useStore.setState({ assistantDot: true, assistantDotGlyph: '●' })
    const { container } = row({ id: 'm-modern', role: 'assistant', sender: 'peri', content: '现代界面', time: 't' })
    expect(container.querySelector('.term-assistant-dot svg')).not.toBeNull()
    expect(container.querySelector('.term-assistant-dot')?.textContent).toBe('')
  })

  test('assistantDot 关闭时不渲染圆点', () => {
    useStore.setState({ assistantDot: false })
    const { container } = row({ id: 'm3', role: 'assistant', sender: 'peri', content: '无圆点', time: 't' })
    expect(container.querySelector('.term-assistant-dot')).toBeNull()
  })

  test('user 消息渲染 sender 与内容', () => {
    row({ id: 'u1', role: 'user', sender: 'local:demo', content: '用户提问', time: 't' }, 'user')
    expect(screen.getByText('用户提问')).toBeTruthy()
  })

  test('React generic reasoning fallback displays canonical duration instead of character count', () => {
    row({
      id: 'r1', role: 'reasoning', sender: 'claude', content: '可见推理正文', time: 't',
      thoughtDurationMs: 2_400,
    }, 'reasoning')
    expect(screen.getByRole('button', { name: /Thought for 2\.4s/ })).toBeTruthy()
    expect(screen.queryByText(/chars/)).toBeNull()
  })

  test('React generic reasoning fallback never renders redacted raw text', () => {
    const { container } = row({
      id: 'r2', role: 'reasoning', sender: 'claude', content: 'private chain of thought', time: 't',
      redacted: true, redactedReason: 'provider_policy',
    }, 'reasoning')
    expect(screen.getByText('推理已被隐藏')).toBeTruthy()
    expect(screen.getByText('provider_policy')).toBeTruthy()
    expect(container.textContent).not.toContain('private chain of thought')
    expect(container.querySelector('button')).toBeNull()
  })
})
