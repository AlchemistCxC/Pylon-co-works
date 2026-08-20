import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportRuntimeError } from '../../runtimeError.ts'

export class PluginContributionBoundary extends Component<{
  contributionId: string
  children: ReactNode
}, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) { return { error } }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportRuntimeError(`渲染插件贡献 ${this.props.contributionId}`, new Error(`${error.message}\n${info.componentStack ?? ''}`))
  }

  render() {
    if (this.state.error) return <div className="context-panel-placeholder" role="alert">此插件面板暂时不可用</div>
    return this.props.children
  }
}
