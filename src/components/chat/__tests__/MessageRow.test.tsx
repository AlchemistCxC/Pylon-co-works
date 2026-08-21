// @vitest-environment jsdom
import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AssistantContent, MessageRow } from '../ChatView'
import { useStore } from '../../../store'
import type { Message } from '../messageTypes'
import { useInterfaceModeStore } from '../../../domains/interface/interfaceModeStore'

function row(message: Message, type: 'assistant' | 'user' = 'assistant') {
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
})
