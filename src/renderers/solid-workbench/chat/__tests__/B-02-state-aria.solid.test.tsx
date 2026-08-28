// @vitest-environment jsdom
import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { SolidToolCard } from '../ToolCard.solid.tsx'
import type { Message } from '../../../../components/chat/messageTypes.ts'

afterEach(cleanup)

function toolMessage(state: string, output?: string): Message {
  return {
    id: `tool-b02-${state}`,
    role: 'tool',
    sender: 'tool:Fixture',
    content: '',
    time: '10:25',
    toolName: 'Fixture',
    toolStatus: state,
    ...(output !== undefined ? { toolOutput: output } : {}),
  }
}

describe('B-02 tool state labels and ARIA', () => {
  it.each([
    ['queued', '排队中'],
    ['running', '运行中'],
    ['waiting', '等待中'],
    ['completed', '已完成'],
    ['failed', '失败'],
    ['cancelled', '已取消'],
    ['unknown', '状态未知'],
  ])('keeps %s source state and readable label', (state, label) => {
    const message = toolMessage(state, state === 'completed' || state === 'cancelled' ? 'fixture output' : undefined)
    const { container } = render(() => <SolidToolCard
      message={message}
      appearance={{ toolIndicator: 'circle', toolIndicatorGlow: 0, toolIndicatorGlowColor: '' }}
    />)

    const card = container.querySelector<HTMLElement>('[data-tool-state]')
    expect(card?.dataset.toolState).toBe(state)
    expect(card?.dataset.statusLabel).toBe(label)
    expect(card).toHaveTextContent(label)
    expect(screen.getByRole('button', { name: new RegExp(label) })).toBeTruthy()
  })
})
