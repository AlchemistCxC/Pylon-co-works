import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportRuntimeError } from '../../runtimeError.ts'

export class PluginContributionBoundary extends Component<{
  contributionId: string
  children: ReactNode
}, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) { return { error } }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The boundary's local placeholder is the user-facing context. Keep the
    // crash searchable in Runtime diagnostics without duplicating a global
    // tray error for the same isolated contribution.
    reportRuntimeError(`渲染插件贡献 ${this.props.contributionId}`, new Error(`${error.message}\n${info.componentStack ?? ''}`), undefined, {
      key: `plugin-contribution:${this.props.contributionId}`,
      visibility: 'diagnostic',
      scope: { kind: 'operation', id: `plugin-contribution:${this.props.contributionId}` },
      source: 'plugin.contribution-boundary',
    })
  }

  render() {
    if (this.state.error) return <div className="context-panel-placeholder" role="alert">此插件面板暂时不可用</div>
    return this.props.children
  }
}
