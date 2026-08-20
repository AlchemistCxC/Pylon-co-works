import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  rendererId: string
  onError: (error: unknown) => 'fallback' | 'rethrow'
  onFallback: (rendererId: string) => void
  children: ReactNode
}

interface State { error: unknown | null }

/** Keeps a broken plugin renderer local to its tab and lets the host select the next renderer. */
export default class FileViewRenderBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State { return { error } }

  componentDidCatch(error: unknown, _info: ErrorInfo) {
    if (this.props.onError(error) === 'fallback') this.props.onFallback(this.props.rendererId)
  }

  componentDidUpdate(previous: Props) {
    if (previous.rendererId !== this.props.rendererId && this.state.error) this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    if (this.props.onError(this.state.error) === 'rethrow') throw this.state.error
    return <div className="file-tab-empty">正在切换到备用文件视图…</div>
  }
}
