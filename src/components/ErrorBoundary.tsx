import { Component, ErrorInfo, ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State { return { error } }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Prism Desktop crashed:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center',
          height:'100%', flexDirection:'column', gap:16, color:'var(--text-dim)', fontFamily:'var(--font)' }}>
          <div style={{ fontSize:48, fontWeight:200 }}>!</div>
          <div style={{ fontSize:16, fontWeight:600, color:'var(--text)' }}>Prism Desktop 遇到了一个错误</div>
          <div style={{ fontSize:13, maxWidth:400, textAlign:'center', fontFamily:'var(--mono)' }}>
            {this.state.error.message}
          </div>
          <button onClick={() => this.setState({ error: null })}
            style={{ padding:'8px 20px', border:'1px solid var(--border)', borderRadius:6,
              background:'var(--bg-panel)', color:'var(--text)', cursor:'pointer' }}>
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
