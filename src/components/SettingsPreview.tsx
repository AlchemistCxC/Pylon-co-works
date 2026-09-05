import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { resolveSpinnerFrames, resolveSpinnerMarker } from './chat/spinnerFrames'
import { resolveConnectorColor, type ToolConnectorStatus } from '../domains/tool/toolPresentation'
import { resolveToolIndicatorAssetForTone } from './chat/toolIndicatorAssets'
import { toCssBackgroundImage } from '../backgroundImage'
import { THEME_DEFAULTS, THEME_SETTING_KEYS } from '../themeFieldDefs'
import { loadSettingsPreviewControlCenter, type SettingsPreviewControlCenterHandle } from '../renderers/solid-workbench/settingsPreviewControlCenterLoader.ts'
import { useShallow } from 'zustand/react/shallow'

interface Props { zone: string }

const PREVIEW_TOOLS = [
  { name: 'Read', input: 'src/main.ts', status: 'ok' },
  { name: 'Bash', input: 'npm run build', status: 'err' },
  { name: 'Edit', input: 'src/main.ts', status: 'run' },
] as const

/**
 * P52 D4：中控预览挂真实 SolidControlCenter（用户拍板弃静态占位）。
 * 经 loader（import.meta.glob）加载 .solid 挂载文件；主题经 useStore 订阅实时
 * 同步。加载失败回退静态 cc 壳（预览不因 Solid 面异常整页崩）。
 */
function PvSolidControlCenter() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let handle: SettingsPreviewControlCenterHandle | undefined
    let unsubscribeTheme: (() => void) | undefined
    const themeSnapshot = () => Object.fromEntries(THEME_SETTING_KEYS.map(key => [key, useStore.getState()[key]]))
    void loadSettingsPreviewControlCenter()
      .then(({ mountSettingsPreviewControlCenter }) => {
        if (disposed) return
        handle = mountSettingsPreviewControlCenter(host)
        handle.setTheme({ ...THEME_DEFAULTS, ...themeSnapshot() })
        unsubscribeTheme = useStore.subscribe(() => {
          handle?.setTheme({ ...THEME_DEFAULTS, ...themeSnapshot() })
        })
      })
      .catch(() => { if (!disposed) setFailed(true) })
    return () => {
      disposed = true
      unsubscribeTheme?.()
      handle?.destroy()
    }
  }, [])
  if (failed) return (
    <div className="control-center cc-variant-peri" style={{ pointerEvents: 'none' }} aria-label="中控预览占位">
      <div className="cc-status-secondary" />
      <div className="cc-status-primary" />
      <div className="cc-actions" />
    </div>
  )
  return <div ref={hostRef} aria-label="Solid 中控预览" />
}

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
  const {
    rightBg,
    rightBgImage,
    rightWidth,
    rightTransparency,
    rightBlur,
    rawConnectorMode,
    rawConnectorColor,
    connectorStyle,
    connectorWidth,
    connectorOpacity,
    toolOk,
    toolRun,
    toolErr,
  } = useStore(useShallow(s => ({
    rightBg: s.rightBg,
    rightBgImage: s.rightBgImage,
    rightWidth: s.rightWidth,
    rightTransparency: s.rightTransparency,
    rightBlur: s.rightBlur,
    rawConnectorMode: s.toolConnectorMode,
    rawConnectorColor: s.toolConnectorColor,
    connectorStyle: s.toolConnectorStyle,
    connectorWidth: s.toolConnectorWidth,
    connectorOpacity: s.toolConnectorOpacity,
    toolOk: s.toolOk,
    toolRun: s.toolRun,
    toolErr: s.toolErr,
  })))
  const connectorMode = rawConnectorMode || 'none'
  const connectorColor = rawConnectorColor || 'rgba(0,0,0,0.12)'
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
      <div className="titlebar" style={{ ...z('global'), WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion?: string }}>
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
            <div style={z('cc')}><PvSolidControlCenter /></div>
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
  const { rawUserName, rawPrefix, userColor } = useStore(useShallow(s => ({
    rawUserName: s.userName,
    rawPrefix: s.userPrefix,
    userColor: s.userColor,
  })))
  const userName = rawUserName || 'user'
  const prefix = rawPrefix || '❯'
  const cs = userColor ? { color: userColor } : undefined
  return <><span className="term-user-prefix" style={cs}>{prefix}</span><span className="term-user-name" style={cs}>{userName}</span><span>帮我检查一下这段代码</span></>
}

function PvSpinner() {
  const {
    preset,
    customFrames,
    doneMarker,
    cancelledMarker,
    errorMarker,
    doneMode,
    cancelledMode,
    errorMode,
    spinnerSize,
  } = useStore(useShallow(s => ({
    preset: s.spinnerFramePreset,
    customFrames: s.spinnerCustomFrames,
    doneMarker: s.spinnerDoneMarker,
    cancelledMarker: s.spinnerCancelledMarker,
    errorMarker: s.spinnerErrorMarker,
    doneMode: s.spinnerDoneMarkerMode,
    cancelledMode: s.spinnerCancelledMarkerMode,
    errorMode: s.spinnerErrorMarkerMode,
    spinnerSize: s.spinnerSize,
  })))
  const frames = resolveSpinnerFrames(preset, customFrames)
  // P52 D4：React GenerationFooter 已退役——预览用同一 resolveSpinnerMarker
  // 呈现三终态标记（终态文案契约由 Solid footer 测试锁定，此处仅视觉预览）。
  const markers = [
    { reason: 'done' as const, mode: doneMode, marker: doneMarker, label: '生成完毕', cls: 'term-summary-done' },
    { reason: 'cancelled' as const, mode: cancelledMode, marker: cancelledMarker, label: '已停止', cls: 'term-summary-cancelled' },
    { reason: 'error' as const, mode: errorMode, marker: errorMarker, label: '处理失败', cls: 'term-summary-error' },
  ]
  return <>
    <div className="term-spinner-row">
      <div className="term-spinner" data-activity="active">
        <span className="spinner-frame" style={{ fontSize: `${spinnerSize}px` }}>{frames[0]}</span>
        <span className="spinner-meta">(<span>3s</span>)</span>
      </div>
    </div>
    {markers.map(item => (
      <div className={`term-summary ${item.cls}`} key={item.reason}>
        <span className="term-summary-frame" style={{ fontSize: `${spinnerSize}px` }}>
          {resolveSpinnerMarker(frames, item.mode, item.marker)}
        </span>
        <span>{item.label} 3s</span>
      </div>
    ))}
    <span className="term-preview-spinner-markers" aria-hidden="true">
      {doneMode}:{doneMarker} {cancelledMode}:{cancelledMarker} {errorMode}:{errorMarker}
    </span>
  </>
}

function PvTool({ name, input, status }: { name: string; input: string; status: ToolConnectorStatus }) {
  const {
    toolOk,
    toolRun,
    toolErr,
    toolIndicator,
    toolIndicatorRun,
    toolIndicatorOk,
    toolIndicatorErr,
    glow,
    glowColor,
  } = useStore(useShallow(s => ({
    toolOk: s.toolOk,
    toolRun: s.toolRun,
    toolErr: s.toolErr,
    toolIndicator: s.toolIndicator,
    toolIndicatorRun: s.toolIndicatorRun,
    toolIndicatorOk: s.toolIndicatorOk,
    toolIndicatorErr: s.toolIndicatorErr,
    glow: s.toolIndicatorGlow,
    glowColor: s.toolIndicatorGlowColor,
  })))
  const indicatorAsset = resolveToolIndicatorAssetForTone(status, { toolIndicator, toolIndicatorRun, toolIndicatorOk, toolIndicatorErr })
  const safeGlow = glow || 0
  const safeGlowColor = glowColor || ''
  const statusColor = status === 'ok' ? toolOk : status === 'err' ? toolErr : toolRun
  const glowCss = safeGlow > 0 ? { textShadow: `0 0 ${safeGlow}px ${safeGlowColor || statusColor || 'currentColor'}` } : undefined
  return <div className="term-tool" data-status={status}><div className="term-tool-head"><span className={`term-tool-indicator ${status}`} aria-label={indicatorAsset.ariaLabel[status === 'ok' ? 'completed' : status === 'err' ? 'failed' : 'running']} role="img" style={glowCss}>{indicatorAsset.glyph}</span><span className="term-tool-name">{name}</span><span className="term-tool-summary term-tool-summary-code"> ({input})</span>{status === 'ok' && <span className="term-tool-suffix"> — 12 lines</span>}</div></div>
}
