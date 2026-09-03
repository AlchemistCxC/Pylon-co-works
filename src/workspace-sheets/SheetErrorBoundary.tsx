import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportRuntimeDiagnostic, resolveRuntimeErrors } from '../runtimeError.ts'

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
    // The blocking Sheet fallback is already the authoritative presentation.
    // Keep the technical fact queryable without creating a second global tray
    // notification for the same crash.
    reportRuntimeDiagnostic('Sheet 渲染失败', error, undefined, {
      key: `sheet-render:${this.props.sheetId}`,
      scope: { kind: 'sheet', id: this.props.sheetId },
      source: 'sheet.boundary',
      recovery: { kind: 'open-runtime-log', sheetId: this.props.sheetId },
    })
  }

  render() {
    if (this.state.error) {
      return (
        <div className="sheet-empty-host" role="alert">
          <div className="sheet-empty-kicker">SHEET ERROR</div>
          <h2>此 Sheet 渲染失败</h2>
          <p>{this.state.error.message}</p>
          <button type="button" className="template-apply" onClick={() => {
            resolveRuntimeErrors({ key: `sheet-render:${this.props.sheetId}` })
            this.setState({ error: null })
          }}>重试</button>
        </div>
      )
    }
    return this.props.children
  }
}
