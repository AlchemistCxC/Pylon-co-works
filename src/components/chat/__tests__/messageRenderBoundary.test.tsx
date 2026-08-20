// @vitest-environment jsdom
/**
 * 行为化承接 scripts/test-message-render-boundary.mts：
 * MessageRenderBoundary 捕获单条消息渲染异常 → 渲染 .term-row-error fallback
 * + reportRuntimeError 上报，不影响兄弟消息。原守卫断言 class 组件
 * getDerivedStateFromError/componentDidCatch/reportRuntimeError 接线，
 * 这里渲染抛错子组件验证真实行为。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MessageRenderBoundary } from '../MessageRenderBoundary'
import type { Message } from '../messageTypes'

const { reportMock } = vi.hoisted(() => ({ reportMock: vi.fn() }))
vi.mock('../../../runtimeError', () => ({ reportRuntimeError: (...args: unknown[]) => reportMock(...args) }))

function ThrowingChild(): React.ReactElement {
  throw new Error('boom in message render')
}

function makeMessage(role: Message['role'] = 'assistant'): Message {
  return { id: 'msg-1', role, sender: 'peri', content: 'x', time: 't' }
}

beforeEach(() => { reportMock.mockReset() })
afterEach(() => { cleanup() })

describe('MessageRenderBoundary（message-render-boundary 契约）', () => {
  it('子组件抛错 → 渲染 term-row-error fallback + role 显示', () => {
    render(
      <MessageRenderBoundary message={makeMessage('assistant')}>
        <ThrowingChild />
      </MessageRenderBoundary>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('消息渲染失败')).toBeTruthy()
    expect(document.querySelector('.term-row-error')).not.toBeNull()
    expect(document.querySelector('.term-row-error-detail')?.textContent).toBe('assistant')
  })

  it('抛错 → reportRuntimeError 被调用且携带消息 id', () => {
    render(
      <MessageRenderBoundary message={makeMessage('tool')}>
        <ThrowingChild />
      </MessageRenderBoundary>,
    )
    expect(reportMock).toHaveBeenCalled()
    expect(reportMock.mock.calls[0][0]).toContain('msg-1')
  })

  it('正常子组件不触发 fallback 不上报', () => {
    render(
      <MessageRenderBoundary message={makeMessage()}>
        <div>正常内容</div>
      </MessageRenderBoundary>,
    )
    expect(screen.getByText('正常内容')).toBeTruthy()
    expect(document.querySelector('.term-row-error')).toBeNull()
    expect(reportMock).not.toHaveBeenCalled()
  })
})
