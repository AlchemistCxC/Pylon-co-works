import { useState, useEffect, useRef } from 'react'
import ControlCenter from './ControlCenter'
import { useStore } from '../store'

/**
 * SettingsPreview — 设置页右侧实时预览
 *
 * 画布尺寸跟随实际窗口（window.innerWidth × innerHeight-32px标题栏），
 * 保证 CC widget 百分比定位与真实界面一致。
 * 预览面板自适应宽度，内容等比缩放填入。
 *
 * pointer-events:none：预览只读，点击不会误触发交互 / 污染 store。
 */

interface Props { zone: string }

export default function SettingsPreview({ zone }: Props) {
  const [dims, setDims] = useState({ w: window.innerWidth, h: window.innerHeight - 32 })
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const update = () => setDims({ w: window.innerWidth, h: window.innerHeight - 32 })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  const { w, h } = dims
  // 动态缩放：预览面板宽 / 画布宽
  const wrapW = wrapRef.current?.clientWidth ?? w
  const scale = Math.min(1, wrapW / w)

  return (
    <div className="set-preview-wrap" ref={wrapRef}>
      <div className="set-preview-frame" style={{ height: 0, paddingBottom: `${(h / w) * 100}%` }}>
        <div className="set-preview-clip">
          <div className="set-preview-scaled" style={{ width: w, height: h, transform: `scale(${scale})` }}>
            <PreviewApp zone={zone} />
          </div>
        </div>
      </div>
      <div className="set-preview-caption">{zone} · 实时预览（{w}×{h}）</div>
    </div>
  )
}

// ── 预览应用：真实 CSS 类骨架 + 真实 ControlCenter ──────────────
function PreviewApp({ zone }: { zone: string }) {
  const z = (name: string): React.CSSProperties =>
    zone === name ? { outline: '2px solid var(--accent,#3b82f6)', outlineOffset: '-2px' } : {}

  return (
    <div className="pv-app" style={{ pointerEvents: 'none' }}>
      {/* Titlebar — 真实类 */}
      <div className="titlebar" style={{ ...z('global'), WebkitAppRegion: 'no-drag' } as any}>
        <span className="titlebar-toggle">☰</span>
        <div className="titlebar-tabs">
          <button className="tab active">Peri</button>
          <button className="tab">Prism</button>
        </div>
      </div>

      <div className="layout" style={{ flex: 1, minHeight: 0 }}>
        {/* Sidebar — 真实类 */}
        <aside className="sidebar" style={z('sidebar')}>
          <div className="sidebar-header">
            <input className="search-input" placeholder="搜索会话..." readOnly />
            <span className="sidebar-action">+</span>
          </div>
          <div className="session-list">
            <div className="group-header" style={{ display: 'block' }}>本地</div>
            {['会话 A', '会话 B', '会话 C'].map((n, i) => (
              <div key={n} className={`session-item ${i === 0 ? 'active' : ''}`}>
                <span className="session-dot" />
                <div className="session-info">
                  <div className="session-name">{n}</div>
                  <div className="session-meta">刚刚</div>
                </div>
              </div>
            ))}
          </div>
          <div className="profile-bar">
            <span className="profile-avatar active">R</span>
            <span className="profile-avatar">S</span>
          </div>
        </aside>

        {/* Main */}
        <div className="main" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div className="main-body" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {/* Chat — 真实 .term 类 */}
            <div className="chat-view" style={z('chat')}>
              <div className="term">
                <div className="term-user">
                  <PvUser />
                </div>
                {[
                  { name: 'Read', input: 'src/main.ts', done: true },
                  { name: 'Bash', input: 'npm run build', done: true },
                  { name: 'Edit', input: 'src/main.ts', done: false },
                ].map((tl, i) => (
                  <div key={i} className={`term-row term-row-tool`}>
                    <PvTool {...tl} />
                  </div>
                ))}
                <PvSpinner />
                <div className="term-assistant">
                  好的，我来分析一下。<code className="term-inline-code">main()</code> 里有一处类型错误需要修正。
                <div className="term-code-block">
                  <div className="term-code-line">
                    <span className="term-code-gutter">│ </span>
                    <span>const result = await fetch(url)</span>
                  </div>
                </div>
                </div>
              </div>
            </div>

            {/* Control center — 真实组件！ */}
            <div style={z('cc')}>
              <ControlCenter sessionId={null} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// 预览用户行 — 读 store（userName/userPrefix/userColor）
function PvUser() {
  const userName = useStore(s => s.userName) || 'user'
  const prefix = useStore(s => s.userPrefix) || '❯'
  const userColor = useStore(s => s.userColor)
  const cs = userColor ? { color: userColor } : undefined
  return (
    <>
      <span className="term-user-prefix" style={cs}>{prefix}</span>
      <span className="term-user-name" style={cs}>{userName}</span>
      <span>帮我检查一下这段代码</span>
    </>
  )
}

// 预览 spinner — 读 store（sparkles/spinnerColor/spinnerSize）
function PvSpinner() {
  const sparkles = useStore(s => s.sparkles) || '✳✴✵✶✷✸✹✺✻✼❃❊'
  const spinnerColor = useStore(s => s.spinnerColor)
  const spinnerSize = useStore(s => s.spinnerSize) || 14
  const frames = sparkles.split('')
  return (
    <div className="term-spinner-row">
      <div className="term-spinner" style={{ fontSize: spinnerSize } as React.CSSProperties}>
        <span className="spinner-frame" style={{ color: spinnerColor || 'var(--accent)' }}>{frames[0]}</span>
        <span className="spinner-verb" style={{ color: spinnerColor || 'var(--accent)' }}>格物致知</span>
        <span className="spinner-meta">(3s · ↓ 1.2K tokens)</span>
      </div>
    </div>
  )
}

// 复用真实 ToolCard 的类，让竖线连接 / 辉光 / 颜色全部由真实 CSS 驱动
function PvTool({ name, input, done }: { name: string; input: string; done: boolean }) {
  const connMode = useStore(s => s.toolConnectorMode) || 'none'
  const connColor = useStore(s => s.toolConnectorColor) || 'rgba(128,128,128,0.3)'
  const toolOk = useStore(s => s.toolOk)
  const toolRun = useStore(s => s.toolRun)
  const indicator = useStore(s => s.toolIndicator) || '●'
  const glow = useStore(s => s.toolIndicatorGlow) || 0
  const glowColor = useStore(s => s.toolIndicatorGlowColor) || ''
  const statusColor = done ? toolOk : toolRun
  const conn = connMode === 'none' ? 'transparent'
    : connMode === 'follow' ? statusColor
    : connColor
  const glowCss = glow > 0
    ? { textShadow: `0 0 ${glow}px ${glowColor || statusColor || 'currentColor'}` }
    : undefined
  return (
    <div className="term-tool" data-status={done ? 'ok' : 'run'}
      style={{ '--tool-conn': conn } as React.CSSProperties}>
      <div className="term-tool-head">
        <span className={`term-tool-indicator ${done ? 'ok' : 'run'}`} style={glowCss}>{indicator}</span>
        <span className="term-tool-name">{name}</span>
        <span className="term-tool-summary"> ({input})</span>
        {done && <span className="term-tool-suffix"> — 12 lines</span>}
      </div>
    </div>
  )
}
