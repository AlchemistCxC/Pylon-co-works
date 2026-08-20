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
    reportRuntimeError(`渲染消息 ${this.props.message.id}`, error)
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
