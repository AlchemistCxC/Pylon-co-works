import React from 'react'
import { reportRuntimeError } from '../../runtimeError'
import type { Message } from './messageTypes'

interface Props {
  message: Message
  children: React.ReactNode
}

interface State {
  hasError: boolean
}

/**
 * 将单条消息的渲染故障限制在本行内，避免异常 Markdown/tool 输出击穿整个 ChatView。
 */
export class MessageRenderBoundary extends React.Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: unknown): void {
    // The row fallback below is already visible in context. Record the
    // technical fact for Runtime diagnostics without duplicating it in the
    // global notification tray.
    reportRuntimeError(`渲染消息 ${this.props.message.id}`, error, undefined, {
      key: `message-render:${this.props.message.id}`,
      visibility: 'diagnostic',
      scope: { kind: 'operation', id: `message-render:${this.props.message.id}` },
      source: 'chat.message-render',
    })
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="term-row-error" role="alert">
          <span>消息渲染失败</span>
          <span className="term-row-error-detail">{this.props.message.role}</span>
        </div>
      )
    }
    return this.props.children
  }
}
