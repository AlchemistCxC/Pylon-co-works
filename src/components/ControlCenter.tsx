import { useRef, useState, useCallback, useEffect } from 'react'
import { useStore } from '../store'
import InputBar from './chat/InputBar'
import ModelWidget from './chat/ModelWidget'
import ModeWidget from './chat/ModeWidget'
import SendWidget from './chat/SendWidget'
import AttachWidget from './chat/AttachWidget'
import ColorPopover from './ColorPopover'
import { formatCacheReadTokens, formatTokenCount } from '../tokenFormat'
import { toCssBackgroundImage } from '../backgroundImage'
import './ControlCenter.css'
import './chat/StatusBar.css'  // model/mode/send/attach widget 样式

interface Props { sessionId: string | null }

function EkgWidget() {
  const tokensUsed = useStore(s => s.liveTokensUsed) || 0
  const tokensMax = useStore(s => s.liveTokensMax) || 128
  const used = Math.max(0, Math.min(1, tokensMax > 0 ? tokensUsed / tokensMax : 0))
  const pct = Math.round(used * 100)
  const barTrackColor = useStore(s => s.barTrackColor)
  const barFillColor = useStore(s => s.barFillColor)
  const barFillFollow = useStore(s => s.barFillFollow)
  const barHeight = useStore(s => s.barHeight) || 10
  const ekgGreen = useStore(s => s.ekgGreen)
  const ekgYellow = useStore(s => s.ekgYellow)
  const ekgRed = useStore(s => s.ekgRed)
  const color = used < 0.50 ? (ekgGreen || '#34d399') : used < 0.80 ? (ekgYellow || '#fbbf24') : (ekgRed || '#f87171')
  const barFill = (barFillFollow !== false) ? color : (barFillColor || color)
  const ccScale = useStore(s => (s.ccScale || {})['ekg'] ?? 100)
  const ccStyle = useStore(s => s.ccStyle) || 'bar'
  // 柱状条
  if (ccStyle === 'numeric') {
    return <span className="ekg-pct" style={{ color, fontSize: `${ccScale}%` }}>{pct}%</span>
  }
  if (ccStyle === 'bar') {
    return (
      <div className="ekg-bar" style={{
        '--bar-fill': `${pct}%`, '--bar-color': barFill,
        '--bar-track': barTrackColor || 'rgba(0,0,0,0.18)',
        '--bar-h': `${barHeight}px`,
        fontSize: `${ccScale}%`,
      } as React.CSSProperties}>
        <div className="ekg-bar-track" />
        <div className="ekg-bar-fill" />
      </div>
    )
  }
  // wave — 简化版 SVG
  return (
    <svg viewBox="0 0 140 30" className="ekg-svg" preserveAspectRatio="none"
      style={{ fontSize: `${ccScale}%` } as React.CSSProperties}>
      <rect x={0} y={12} width={140 * (1 - used)} height={6} rx={3} fill={color} opacity={0.3} />
      <rect x={140 * (1 - used)} y={12} width={140 * used} height={6} rx={3} fill="var(--ekg-consumed,rgba(128,128,128,0.15))" />
    </svg>
  )
}

function PctWidget() {
  const tokensUsed = useStore(s => s.liveTokensUsed) || 0
  const tokensMax = useStore(s => s.liveTokensMax) || 128
  const used = Math.max(0, Math.min(1, tokensMax > 0 ? tokensUsed / tokensMax : 0))
  const pct = Math.round(used * 100)
  const ekgGreen = useStore(s => s.ekgGreen)
  const ekgYellow = useStore(s => s.ekgYellow)
  const ekgRed = useStore(s => s.ekgRed)
  const color = used < 0.50 ? (ekgGreen || '#34d399') : used < 0.80 ? (ekgYellow || '#fbbf24') : (ekgRed || '#f87171')
  const ccScale = useStore(s => (s.ccScale || {})['pct'] ?? 100)
  return <span className="ekg-pct" style={{ color, fontSize: `${ccScale}%` }}>{pct}%</span>
}

function TokensWidget() {
  const tokensUsed = useStore(s => s.liveTokensUsed) || 0
  const tokensMax = useStore(s => s.liveTokensMax) || 128
  const cacheHit = useStore(s => s.liveCacheReadTokens) || 0
  const ccScale = useStore(s => (s.ccScale || {})['tokens'] ?? 100)
  return (
    <span className="pill-mono" style={{ borderLeft: 'none', padding: 0, fontSize: `${ccScale}%` }}>
      {formatTokenCount(tokensUsed)}/{formatTokenCount(tokensMax)}
      {cacheHit > 0 && <span style={{ color: '#34d399', marginLeft: 4 }}>{formatCacheReadTokens(cacheHit)}</span>}
    </span>
  )
}

// ── Widget 注册表：单一真实源 ──────────────────────────────────
// 新增 widget：在这里加一项即可，画布 + 工具栏自动出现
interface WidgetDef {
  id: string
  label: string
  defaultPos: { x: number; y: number; w: number; h: number }
  render: (sessionId: string | null) => React.ReactNode
}

const WIDGET_REGISTRY: WidgetDef[] = [
  {
    id: 'input', label: '输入栏',
    defaultPos: { x: 0, y: 0, w: 100, h: 52 },
    render: (sid) => <InputBar sessionId={sid} />,
  },
  {
    id: 'ekg', label: '用量条',
    defaultPos: { x: 0, y: 65, w: 30, h: 28 },
    render: () => <EkgWidget />,
  },
  {
    id: 'pct', label: '百分比',
    defaultPos: { x: 32, y: 69, w: 8, h: 20 },
    render: () => <PctWidget />,
  },
  {
    id: 'tokens', label: 'Token数',
    defaultPos: { x: 41, y: 69, w: 16, h: 20 },
    render: () => <TokensWidget />,
  },
  {
    id: 'model', label: '模型',
    defaultPos: { x: 58, y: 69, w: 18, h: 20 },
    render: (sid) => {
      const s = useStore.getState().sessions.find(s => s.id === sid)
      return <ModelWidget sessionSource={s?.source} />
    },
  },
  {
    id: 'mode', label: '权限模式',
    defaultPos: { x: 77, y: 69, w: 10, h: 20 },
    render: (sid) => {
      const s = useStore.getState().sessions.find(s => s.id === sid)
      return <ModeWidget sessionSource={s?.source} />
    },
  },
  {
    id: 'send', label: '发送按钮',
    defaultPos: { x: 89, y: 69, w: 5, h: 20 },
    render: () => null,
  },
  {
    id: 'attach', label: '附件按钮',
    defaultPos: { x: 95, y: 69, w: 4, h: 20 },
    render: () => null,
  },
]

// ── 位置默认值合并（向后兼容老 localStorage 缺失字段） ──────
function ensurePositions(positions: any): Record<string, { x: number; y: number; w?: number; h?: number }> {
  const out: any = { ...(positions || {}) }
  for (const w of WIDGET_REGISTRY) {
    if (!out[w.id]) out[w.id] = w.defaultPos
  }
  return out
}

export default function ControlCenter({ sessionId }: Props) {
  const ccHeight = useStore(s => s.ccHeight) || 120
  const ccBgHeight = useStore(s => s.ccBgHeight ?? ccHeight)
  const inputMode = useStore(s => s.inputMode)
  const hidden = useStore(s => s.ccHidden || [])
  const ccStyle = useStore(s => s.ccStyle)
  const layout = useStore(s => s.ccLayout)
  const editMode = useStore(s => s.ccEditMode)
  const ccVariant = useStore(s => s.ccVariant) || 'terminal'
  const ccBg = useStore(s => s.ccBg) || 'transparent'
  const ccBgImage = useStore(s => s.ccBgImage) || ''
  const setCcEditMode = useStore(s => s.setCcEditMode)
  const setCcHeight = useStore(s => s.setCcHeight)

  const inputRef = useRef<{ send: () => void; attachFile: () => void; cancel: () => void }>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // 把 inputRef 转给 SendWidget / AttachWidget
  const renderWidget = (id: string) => {
    const def = WIDGET_REGISTRY.find(w => w.id === id)
    if (!def) return null
    if (!editMode && hidden.includes(id)) return null
    // numeric 已由 pct widget 表达；两者同时显示会重复成 “0% · 0%”。
    if (!editMode && ccStyle === 'numeric' && id === 'ekg' && !hidden.includes('pct')) return null
    if (!editMode && inputMode === 'cli' && (id === 'send' || id === 'attach')) return null

    // 独立 send/attach widget 是否已启用（在画布上且未隐藏）→ 决定 InputBar 是否隐藏自带按钮
    // CLI 模式下独立按钮自动隐藏，此时 split=false（InputBar 的 CLI CSS 已隐藏自带按钮）
    const externalBtns = inputMode !== 'cli' && (!hidden.includes('send') || !hidden.includes('attach'))
    const inputSplit = externalBtns

    let body: React.ReactNode
    switch (id) {
      case 'input':
        body = <InputBar ref={inputRef} sessionId={sessionId} split={inputSplit} />
        break
      case 'send':
        body = <SendWidget onClick={() => inputRef.current?.send()} />
        break
      case 'attach':
        body = <AttachWidget onClick={() => inputRef.current?.attachFile()} />
        break
      default:
        body = def.render(sessionId)
    }

    const placement = layout.placements[id as keyof typeof layout.placements]
    if (!placement) return null
    // 小控件用 naturalSize（宽高由内容决定，盒子紧贴）— 仅 input 占满槽位
    const isNatural = id !== 'input'
    return (
      <EditableWidget
        key={id} id={id} placement={placement} editMode={editMode}
        naturalSize={isNatural}
        isHidden={hidden.includes(id)}
        bodyRef={ccBodyRef}
        selected={selected === id}
        onSelect={() => setSelected(id)}
      >
        {body}
      </EditableWidget>
    )
  }

  const renderSlot = (slot: 'status-primary' | 'status-secondary' | 'actions') => WIDGET_REGISTRY
    .filter(widget => widget.id !== 'input' && layout.placements[widget.id as keyof typeof layout.placements]?.slot === slot)
    .sort((a, b) => (layout.placements[a.id as keyof typeof layout.placements]?.order ?? 0) - (layout.placements[b.id as keyof typeof layout.placements]?.order ?? 0))
    .map(widget => renderWidget(widget.id))

  const ccBodyRef = useRef<HTMLDivElement>(null)

  // 整体高度拖拽
  const onHeightDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = ccHeight
    const onMove = (ev: MouseEvent) => {
      setCcHeight(startH + startY - ev.clientY)
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [ccHeight, setCcHeight])

  // Escape 退出编辑模式
  useEffect(() => {
    if (!editMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selected) setSelected(null)
        else setCcEditMode(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editMode, selected, setCcEditMode])

  return (
    <div className={`control-center ${inputMode === 'cli' ? 'cli-mode' : ''} ${editMode ? 'cc-editing' : ''} cc-variant-${ccVariant}`}
      style={{ '--cc-height': `${ccHeight}px`, '--cc-bg-height': `${ccBgHeight}px`, '--cc-bg': ccBg, '--cc-bg-image': toCssBackgroundImage(ccBgImage) } as React.CSSProperties}>
      {editMode && (
        <div className="cc-edit-hdr" onMouseDown={onHeightDrag}>
          <div className="cc-edit-hdr-bar" />
          <span className="cc-edit-hdr-label">{ccHeight}px</span>
        </div>
      )}
      <div className="cc-bg" />
      <div className="cc-body" ref={ccBodyRef}>
        <div className="cc-input-slot">{renderWidget('input')}</div>
        <div className="cc-status-row">
          <div className="cc-status-primary">{renderSlot('status-primary')}</div>
          <div className="cc-status-secondary">{renderSlot('status-secondary')}</div>
          <div className="cc-actions">{renderSlot('actions')}</div>
        </div>
      </div>
      {editMode && selected && <PropertyPanel id={selected} onClose={() => setSelected(null)} onExit={() => { setCcEditMode(false); setSelected(null) }} />}
      {editMode && (
        <WidgetToolbar
          selected={selected}
          onSelect={(id) => setSelected(id)}
        />
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────────
// EditableWidget：单一职责，干净指针事件
// ───────────────────────────────────────────────────────────────

function EditableWidget({ id, placement, editMode, isHidden, children, bodyRef, selected, onSelect, naturalSize }: {
  id: string
  placement: { slot: 'input' | 'status-primary' | 'status-secondary' | 'actions'; order: number; offsetX: number; offsetY: number }
  editMode: boolean
  isHidden: boolean
  children: React.ReactNode
  bodyRef: React.RefObject<HTMLDivElement | null>
  selected: boolean
  onSelect: () => void
  // 文字型控件(model/mode/send/attach)用 naturalSize=true — 宽高随内容自适应
  naturalSize?: boolean
}) {
  // 拖拽 / 缩放 — 使用 Pointer Events（统一鼠标+触屏）
  // 直接读 store.getState() 拿最新 pos，避免闭包过期

  const handleWidgetPointerDown = (e: React.PointerEvent) => {
    if (!editMode) return
    if (isControlHandle(e.target as HTMLElement)) return
    e.stopPropagation()
    e.preventDefault()
    onSelect()
    const body = bodyRef.current; if (!body) return
    const startX = e.clientX, startY = e.clientY
    const currentLayout = useStore.getState().ccLayout
    const start = currentLayout.placements[id as keyof typeof currentLayout.placements] || placement
    const onMove = (ev: PointerEvent) => {
      useStore.getState().updateCcPlacement(id, {
        offsetX: start.offsetX + ev.clientX - startX,
        offsetY: start.offsetY + ev.clientY - startY,
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      data-widget-id={id}
      className={`cc-widget ${editMode ? 'cc-edit' : ''} ${editMode && isHidden ? 'cc-hidden' : ''} ${selected ? 'cc-selected' : ''} ${naturalSize ? 'cc-natural' : ''}`}
      style={{ transform: `translate(${placement.offsetX}px, ${placement.offsetY}px)` }}
      onPointerDown={editMode ? handleWidgetPointerDown : undefined}
    >
      {children}
    </div>
  )
}

// 编辑控件上的 handle 跳过 widget 拖拽
function isControlHandle(_el: HTMLElement | null): boolean {
  return false  // 迷你控件已移除，box 上仅有位置移动功能
}

// ───────────────────────────────────────────────────────────────
// WidgetToolbar：编辑模式下浮在画布底部，显示「增删控件」+ 重置
// ───────────────────────────────────────────────────────────────

function WidgetToolbar({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const hidden = useStore(s => s.ccHidden || [])
  const resetCcLayout = useStore(s => s.resetCcLayout)
  const setCcHidden = useStore(s => s.setCcHidden)
  const setCcEditMode = useStore(s => s.setCcEditMode)

  const reset = () => resetCcLayout()

  const toggleHide = (id: string) => {
    setCcHidden(id, !hidden.includes(id))
  }

  return (
    <div className="cc-edit-toolbar">
      <span className="cc-edit-toolbar-label">控件</span>
      {WIDGET_REGISTRY.map(w => {
        const isHidden = hidden.includes(w.id)
        const isSelected = selected === w.id
        return (
          <button key={w.id}
            className={`cc-edit-toolbar-chip ${isSelected ? 'active' : ''} ${isHidden ? 'dim' : ''}`}
            onClick={() => { onSelect(w.id); toggleHide(w.id) }}
            title={isHidden ? '已隐藏 — 点击恢复' : '显示中 — 点击隐藏'}>
            {isHidden ? '＋' : '●'} {w.label}
          </button>
        )
      })}
      <button className="cc-edit-toolbar-btn" onClick={reset} title="重置所有控件位置到默认">↺ 重置位置</button>
      <button className="cc-edit-toolbar-btn danger" onClick={() => { setCcEditMode(false); onSelect(null) }}>退出编辑</button>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────
// PropertyPanel — 选中控件的属性编辑面板
// ───────────────────────────────────────────────────────────────

function PropertyPanel({ id, onClose, onExit }: { id: string; onClose: () => void; onExit: () => void }) {
  const placement = useStore(s => s.ccLayout.placements[id as keyof typeof s.ccLayout.placements])
  const u = useStore(s => s.updateTheme)
  const updateCcPlacement = useStore(s => s.updateCcPlacement)
  const setCcScale = useStore(s => s.setCcScale)
  const theme = useStore(s => s as any)
  const labels: Record<string, string> = {
    input: '输入栏', ekg: '用量条', pct: '百分比', tokens: 'Token数',
    model: '模型', mode: '权限模式', send: '发送按钮', attach: '附件按钮',
  }

  const up = (k: string, v: any) => u({ [k]: v } as any)
  const upOffset = (key: 'offsetX' | 'offsetY', value: number) => updateCcPlacement(id, { [key]: value })

  return (
    <div className="cc-prop-panel">
      <div className="cc-prop-header">
        <span>{labels[id] || id}</span>
        <button onClick={onClose}>✕</button>
      </div>
      <div className="cc-prop-body">
        <div className="cc-prop-sec">布局</div>
        <div className="cc-prop-field"><label>槽位</label>
          <select className="set-select" value={placement?.slot || 'status-primary'} onChange={event => updateCcPlacement(id, { slot: event.target.value as any })}>
            <option value="input">输入栏</option>
            <option value="status-primary">状态左</option>
            <option value="status-secondary">状态右</option>
            <option value="actions">操作区</option>
          </select>
        </div>
        <div className="cc-prop-field"><label>顺序</label><input type="number" value={placement?.order ?? 0} onChange={event => updateCcPlacement(id, { order: +event.target.value })} step={1} className="set-num" min={0} max={99} /></div>
        <div className="cc-prop-field"><label>水平微调</label><input type="number" value={placement?.offsetX ?? 0} onChange={event => upOffset('offsetX', +event.target.value)} step={1} className="set-num" min={-48} max={48} /><span>px</span></div>
        <div className="cc-prop-field"><label>垂直微调</label><input type="number" value={placement?.offsetY ?? 0} onChange={event => upOffset('offsetY', +event.target.value)} step={1} className="set-num" min={-16} max={16} /><span>px</span></div>
        {id !== 'input' && (
          <div className="cc-prop-field"><label>缩放</label>
            <input type="number" value={(theme.ccScale || {})[id] ?? 100}
              onChange={v => setCcScale(id, +v.target.value)}
              step={5} className="set-num" min={50} max={200} /><span>%</span>
          </div>
        )}

        {id === 'input' && <>
          <div className="cc-prop-sec">输入栏设置</div>
          <div className="cc-prop-field"><label>背景色</label><ColorPopover value={theme.inputBg || ''} onChange={v => up('inputBg', v)} /></div>
          <div className="cc-prop-field"><label>文字色</label><ColorPopover value={theme.inputTextColor || ''} onChange={v => up('inputTextColor', v)} /></div>
          <div className="cc-prop-field"><label>字号</label><input type="number" value={theme.inputFontSize} onChange={v => up('inputFontSize', +v.target.value)} step={0.1} className="set-num" min={12} max={22} /></div>
          <div className="cc-prop-field"><label>最小高</label><input type="number" value={theme.inputMinHeight} onChange={v => up('inputMinHeight', +v.target.value)} step={0.1} className="set-num" min={36} max={120} /></div>
          <div className="cc-prop-field"><label>模式</label>
            <div className="set-preset-row">
              <button className={`set-preset-chip ${theme.inputMode === 'default' ? 'active' : ''}`} onClick={() => up('inputMode', 'default')}>默认</button>
              <button className={`set-preset-chip ${theme.inputMode === 'cli' ? 'active' : ''}`} onClick={() => up('inputMode', 'cli')}>CLI</button>
            </div>
          </div>
          {theme.inputMode === 'cli' && <>
            <div className="cc-prop-field"><label>线宽</label><input type="number" value={theme.cliLineWidth} onChange={v => up('cliLineWidth', +v.target.value)} step={0.1} className="set-num" min={1} max={6} /></div>
            <div className="cc-prop-field"><label>线色</label><ColorPopover value={theme.cliLineColor || ''} onChange={v => up('cliLineColor', v)} /></div>
            <div className="cc-prop-field"><label>行距</label><input type="number" value={(theme as any).cliLinePadding ?? 6} onChange={v => up('cliLinePadding', +v.target.value)} step={0.1} className="set-num" min={0} max={24} /></div>
          </>}
        </>}

        {id === 'ekg' && <>
          <div className="cc-prop-sec">用量条显示</div>
          <div className="cc-prop-field"><label>仪表类型</label>
            <div className="set-preset-row">
              {(['wave', 'bar', 'numeric'] as const).map(s => (
                <button key={s} className={`set-preset-chip ${theme.ccStyle === s ? 'active' : ''}`} onClick={() => up('ccStyle', s)}>
                  {s === 'wave' ? '心电图' : s === 'bar' ? '柱状' : '数值'}
                </button>
              ))}
            </div>
          </div>
          <div className="cc-prop-field"><label>宽度</label><input type="number" value={theme.ekgWidth} onChange={v => up('ekgWidth', +v.target.value)} step={0.1} className="set-num" min={80} max={400} /></div>
          <div className="cc-prop-field"><label>字号</label><input type="number" value={theme.ekgFontSize} onChange={v => up('ekgFontSize', +v.target.value)} step={0.1} className="set-num" min={12} max={22} /></div>
          {theme.ccStyle === 'wave' && <>
            <div className="cc-prop-field"><label>绿色</label><ColorPopover value={theme.ekgGreen || ''} onChange={v => up('ekgGreen', v)} /></div>
            <div className="cc-prop-field"><label>黄色</label><ColorPopover value={theme.ekgYellow || ''} onChange={v => up('ekgYellow', v)} /></div>
            <div className="cc-prop-field"><label>红色</label><ColorPopover value={theme.ekgRed || ''} onChange={v => up('ekgRed', v)} /></div>
            <div className="cc-prop-field"><label>线宽</label><input type="number" value={theme.ekgLineWidth} onChange={v => up('ekgLineWidth', +v.target.value)} step={0.1} className="set-num" min={2} max={20} /></div>
            <div className="cc-prop-field"><label>振幅</label><input type="number" value={theme.ekgAmplitudeMax} onChange={v => up('ekgAmplitudeMax', +v.target.value)} step={0.1} className="set-num" min={5} max={30} /></div>
            <div className="cc-prop-field"><label>波速基</label><input type="number" value={theme.ekgSpeedBase} onChange={v => up('ekgSpeedBase', +v.target.value)} step={0.1} className="set-num" min={0} max={3} /></div>
            <div className="cc-prop-field"><label>波速最</label><input type="number" value={theme.ekgSpeedMax} onChange={v => up('ekgSpeedMax', +v.target.value)} step={0.1} className="set-num" min={0} max={5} /></div>
          </>}
          {theme.ccStyle === 'bar' && <>
            <div className="cc-prop-field"><label>外壳背景</label><ColorPopover value={theme.barTrackColor || ''} onChange={v => up('barTrackColor', v)} /></div>
            <div className="cc-prop-field"><label>高度</label><input type="number" value={theme.barHeight ?? 10} onChange={v => up('barHeight', +v.target.value)} step={0.1} className="set-num" min={4} max={40} /></div>
            <div className="cc-prop-field"><label>柱子跟随用量</label>
              <div className="set-preset-row">
                <button className={`set-preset-chip ${theme.barFillFollow !== false ? 'active' : ''}`} onClick={() => up('barFillFollow', true)}>三段色</button>
                <button className={`set-preset-chip ${theme.barFillFollow === false ? 'active' : ''}`} onClick={() => up('barFillFollow', false)}>固定色</button>
              </div>
            </div>
            {theme.barFillFollow === false && (
              <div className="cc-prop-field"><label>柱子颜色</label><ColorPopover value={theme.barFillColor || ''} onChange={v => up('barFillColor', v)} /></div>
            )}
          </>}
        </>}

        {id === 'model' && <>
          <div className="cc-prop-sec">模型控件外观</div>
          <div className="cc-prop-field"><label>外观风格</label>
            <div className="set-preset-row">
              {(['dropdown', 'minimal', 'badge'] as const).map(v => (
                <button key={v} className={`set-preset-chip ${theme.modelVariant === v ? 'active' : ''}`} onClick={() => up('modelVariant', v)}>
                  {v === 'dropdown' ? '下拉' : v === 'minimal' ? '简洁' : '徽章'}
                </button>
              ))}
            </div>
          </div>
        </>}

        {id === 'mode' && <>
          <div className="cc-prop-sec">模式控件外观</div>
          <div className="cc-prop-field"><label>外观风格</label>
            <div className="set-preset-row">
              {(['pill', 'badge', 'minimal'] as const).map(v => (
                <button key={v} className={`set-preset-chip ${theme.modeVariant === v ? 'active' : ''}`} onClick={() => up('modeVariant', v)}>
                  {v === 'pill' ? '胶囊' : v === 'badge' ? '方括号' : '极简'}
                </button>
              ))}
            </div>
          </div>
          <div className="cc-prop-field"><label>当前</label><span style={{ fontSize: 13, color: theme.liveMode === 'bypass' ? '#FF6B80' : theme.liveMode === 'auto' ? '#FFC107' : theme.liveMode === 'edit' ? '#A2A9E4' : '#999' }}>{theme.liveMode || 'default'}</span></div>
        </>}

        {id === 'send' && <>
          <div className="cc-prop-sec">发送按钮外观</div>
          <div className="cc-prop-field"><label>外观风格</label>
            <div className="set-preset-row">
              {(['icon', 'square', 'minimal'] as const).map(v => (
                <button key={v} className={`set-preset-chip ${theme.sendVariant === v ? 'active' : ''}`} onClick={() => up('sendVariant', v)}>
                  {v === 'icon' ? '圆形' : v === 'square' ? '方形' : '极简'}
                </button>
              ))}
            </div>
          </div>
        </>}

        {id === 'attach' && <>
          <div className="cc-prop-sec">附件按钮外观</div>
          <div className="cc-prop-field"><label>外观风格</label>
            <div className="set-preset-row">
              {(['icon', 'square', 'minimal'] as const).map(v => (
                <button key={v} className={`set-preset-chip ${theme.attachVariant === v ? 'active' : ''}`} onClick={() => up('attachVariant', v)}>
                  {v === 'icon' ? '圆形' : v === 'square' ? '方形' : '极简'}
                </button>
              ))}
            </div>
          </div>
        </>}
      </div>
      <div className="cc-prop-footer">
        <button className="ps-btn sm" onClick={onExit}>退出自定义</button>
      </div>
    </div>
  )
}