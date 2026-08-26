import { useState, useEffect, useRef } from 'react'
import ControlCenter from './ControlCenter'
import { useStore } from '../store'
import GenerationFooter from './chat/GenerationFooter'
import { resolveSpinnerFrames } from './chat/spinnerFrames'
import { resolveConnectorColor, type ToolConnectorStatus } from '../domains/tool/toolPresentation'
import { resolveToolIndicatorAssetForTone } from './chat/toolIndicatorAssets'
import { toCssBackgroundImage } from '../backgroundImage'

interface Props { zone: string }

const PREVIEW_TOOLS = [
  { name: 'Read', input: 'src/main.ts', status: 'ok' },
  { name: 'Bash', input: 'npm run build', status: 'err' },
  { name: 'Edit', input: 'src/main.ts', status: 'run' },
] as const

export default function SettingsPreview({ zone }: Props) {
  const [dims, setDims] = useState(() => ({
    w: typeof window === 'undefined' ? 1200 : window.innerWidth,
    h: typeof window === 'undefined' ? 760 : window.innerHeight - 32,
  }))
  const [wrapWidth, setWrapWidth] = useState(() => typeof window === 'undefined' ? 1200 : window.innerWidth)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const update = () => setDims({ w: window.innerWidth, h: window.innerHeight - 32 })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  useEffect(() => {
    const element = wrapRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWrapWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const { w, h } = dims
  const scale = Math.min(1, wrapWidth / w)

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

function PreviewApp({ zone }: { zone: string }) {
  const rightBg = useStore(s => s.rightBg)
  const rightBgImage = useStore(s => s.rightBgImage)
  const rightWidth = useStore(s => s.rightWidth)
  const rightTransparency = useStore(s => s.rightTransparency)
  const rightBlur = useStore(s => s.rightBlur)
  const connectorMode = useStore(s => s.toolConnectorMode) || 'none'
  const connectorColor = useStore(s => s.toolConnectorColor) || 'rgba(0,0,0,0.12)'
  const connectorStyle = useStore(s => s.toolConnectorStyle)
  const connectorWidth = useStore(s => s.toolConnectorWidth)
  const connectorOpacity = useStore(s => s.toolConnectorOpacity)
  const toolOk = useStore(s => s.toolOk)
  const toolRun = useStore(s => s.toolRun)
  const toolErr = useStore(s => s.toolErr)
  const previewConnectorColor = (status: ToolConnectorStatus) => resolveConnectorColor(
    connectorMode,
    status,
    { toolOk, toolRun, toolErr },
    connectorColor,
  )
  const z = (name: string): React.CSSProperties =>
    zone === name ? { outline: '2px solid var(--accent,#3b82f6)', outlineOffset: '-2px' } : {}
  const rightStyle = {
    '--right-bg': rightBg,
    '--right-bg-image': toCssBackgroundImage(rightBgImage),
    '--right-width': `${rightWidth}px`,
    '--right-transparency': rightTransparency,
    '--right-blur': `${rightBlur}px`,
  } as React.CSSProperties

  return (
    <div className="pv-app" style={{ pointerEvents: 'none' }}>
      <div className="titlebar" style={{ ...z('global'), WebkitAppRegion: 'no-drag' } as any}>
        <span className="titlebar-toggle">☰</span>
        <div className="titlebar-tabs">
          <button className="tab active">Peri</button>
          <button className="tab">Prism</button>
        </div>
      </div>

      <div className="layout" style={{ flex: 1, minHeight: 0 }}>
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
                <div className="session-info"><div className="session-name">{n}</div><div className="session-meta">刚刚</div></div>
              </div>
            ))}
          </div>
          <div className="profile-bar"><span className="profile-avatar active">R</span><span className="profile-avatar">S</span></div>
        </aside>

        <div className="main" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div className="main-body" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div className="chat-view" style={z('chat')}>
              <div className="term">
                <div className="term-user"><PvUser /></div>
                {PREVIEW_TOOLS.map((tl, i) => {
                  const previous = PREVIEW_TOOLS[i - 1]
                  const connectorStatus = previous?.status
                  return (
                    <div
                      className={`pv-tool-row pv-tool-connector-style--${connectorStyle || 'solid'}`}
                      key={tl.name}
                      data-has-connector={connectorStatus ? 'true' : undefined}
                      style={{
                        '--pv-connector-color': connectorStatus ? previewConnectorColor(connectorStatus) : 'transparent',
                        '--pv-connector-width': `${Math.max(1, Math.min(6, connectorWidth || 2))}px`,
                        '--pv-connector-opacity': Math.max(0.1, Math.min(1, connectorOpacity ?? 1)),
                      } as React.CSSProperties}
                    >
                      <div className="term-row term-row-tool"><PvTool {...tl} /></div>
                    </div>
                  )
                })}
                <PvSpinner />
                <div className="term-assistant">
                  好的，我来分析一下。<code className="term-inline-code">main()</code> 里有一处类型错误需要修正。
                  <div className="term-code-block"><div className="term-code-line"><span className="term-code-gutter">│ </span><span>const result = await fetch(url)</span></div></div>
                </div>
              </div>
            </div>
            <div style={z('cc')}><ControlCenter sessionId={null} /></div>
          </div>
        </div>

        <aside className="right-panel pv-right-panel" style={{ ...rightStyle, ...z('right') }}>
          <div className="right-header">
            <div className="right-tabs"><button className="right-tab active">工作区</button><button className="right-tab">日志</button></div>
            <button className="right-close" aria-label="关闭右栏">✕</button>
          </div>
          <div className="right-body"><div className="panel-status"><strong>工作区预览</strong><span>右栏主题实时预览</span></div></div>
        </aside>
      </div>
    </div>
  )
}

function PvUser() {
  const userName = useStore(s => s.userName) || 'user'
  const prefix = useStore(s => s.userPrefix) || '❯'
  const userColor = useStore(s => s.userColor)
  const cs = userColor ? { color: userColor } : undefined
  return <><span className="term-user-prefix" style={cs}>{prefix}</span><span className="term-user-name" style={cs}>{userName}</span><span>帮我检查一下这段代码</span></>
}

function PvSpinner() {
  const preset = useStore(s => s.spinnerFramePreset)
  const customFrames = useStore(s => s.spinnerCustomFrames)
  const doneMarker = useStore(s => s.spinnerDoneMarker)
  const cancelledMarker = useStore(s => s.spinnerCancelledMarker)
  const errorMarker = useStore(s => s.spinnerErrorMarker)
  const doneMode = useStore(s => s.spinnerDoneMarkerMode)
  const cancelledMode = useStore(s => s.spinnerCancelledMarkerMode)
  const errorMode = useStore(s => s.spinnerErrorMarkerMode)
  const frames = resolveSpinnerFrames(preset, customFrames)
  const previewSummary = (reason: 'done' | 'cancelled' | 'error', completedFrame = '') => ({
    elapsedMs: 3000,
    tokenCount: 1200,
    completedFrame,
    reason,
  })
  return <>
    <GenerationFooter running frames={frames} tokenCount={1200} startTime={Date.now() - 3000} summary={null} source={null} />
    <GenerationFooter running={false} frames={frames} tokenCount={1200} startTime={Date.now() - 3000} summary={previewSummary('done')} source={null} />
    <GenerationFooter running={false} frames={frames} tokenCount={1200} startTime={Date.now() - 3000} summary={previewSummary('cancelled')} source={null} />
    <GenerationFooter running={false} frames={frames} tokenCount={1200} startTime={Date.now() - 3000} summary={previewSummary('error')} source={null} />
    <span className="term-preview-spinner-markers" aria-hidden="true">
      {doneMode}:{doneMarker} {cancelledMode}:{cancelledMarker} {errorMode}:{errorMarker}
    </span>
  </>
}

function PvTool({ name, input, status }: { name: string; input: string; status: ToolConnectorStatus }) {
  const toolOk = useStore(s => s.toolOk)
  const toolRun = useStore(s => s.toolRun)
  const toolErr = useStore(s => s.toolErr)
  const toolIndicator = useStore(s => s.toolIndicator)
  const toolIndicatorRun = useStore(s => s.toolIndicatorRun)
  const toolIndicatorOk = useStore(s => s.toolIndicatorOk)
  const toolIndicatorErr = useStore(s => s.toolIndicatorErr)
  const indicatorAsset = resolveToolIndicatorAssetForTone(status, { toolIndicator, toolIndicatorRun, toolIndicatorOk, toolIndicatorErr })
  const glow = useStore(s => s.toolIndicatorGlow) || 0
  const glowColor = useStore(s => s.toolIndicatorGlowColor) || ''
  const statusColor = status === 'ok' ? toolOk : status === 'err' ? toolErr : toolRun
  const glowCss = glow > 0 ? { textShadow: `0 0 ${glow}px ${glowColor || statusColor || 'currentColor'}` } : undefined
  return <div className="term-tool" data-status={status}><div className="term-tool-head"><span className={`term-tool-indicator ${status}`} aria-label={indicatorAsset.ariaLabel[status === 'ok' ? 'completed' : status === 'err' ? 'failed' : 'running']} role="img" style={glowCss}>{indicatorAsset.glyph}</span><span className="term-tool-name">{name}</span><span className="term-tool-summary"> ({input})</span>{status === 'ok' && <span className="term-tool-suffix"> — 12 lines</span>}</div></div>
}
