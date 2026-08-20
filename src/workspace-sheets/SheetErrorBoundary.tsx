import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportRuntimeError } from '../runtimeError'

interface Props { children: ReactNode; sheetId: string }
interface State { error: Error | null }

/**
 * SheetErrorBoundary — Sheet 级错误隔离（报告 8.2）。
 *
 * 单个 Sheet 渲染异常只隔离自身（retry/reset），不拖垮整个应用
 * （应用级 ErrorBoundary 仍由 main.tsx 兜底）。
 */
export default class SheetErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State { return { error } }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    reportRuntimeError('Sheet 渲染失败', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="sheet-empty-host" role="alert">
          <div className="sheet-empty-kicker">SHEET ERROR</div>
          <h2>此 Sheet 渲染失败</h2>
          <p>{this.state.error.message}</p>
          <button type="button" className="template-apply" onClick={() => this.setState({ error: null })}>重试</button>
        </div>
      )
    }
    return this.props.children
  }
}
