import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { useStore } from '../store'
import InputBar from './chat/InputBar'
import StatusBar from './chat/StatusBar'
import ModelWidget from './chat/ModelWidget'
import ModeWidget from './chat/ModeWidget'
import SendWidget from './chat/SendWidget'
import AttachWidget from './chat/AttachWidget'
import ColorPopover from './ColorPopover'
import './ControlCenter.css'

interface Props { sessionId: string | null }

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
    defaultPos: { x: 2, y: 2, w: 96, h: 55 },
    render: (sid) => <InputBar sessionId={sid} />,
  },
  {
    id: 'context', label: '上下文',
    defaultPos: { x: 2, y: 64, w: 56, h: 16 },
    render: () => <StatusBar />,
  },
  {
    id: 'model', label: '模型',
    defaultPos: { x: 60, y: 64, w: 26, h: 16 },
    render: (sid) => {
      const s = useStore.getState().sessions.find(s => s.id === sid)
      return <ModelWidget sessionSource={s?.source} />
    },
  },
  {
    id: 'mode', label: '权限模式',
    defaultPos: { x: 88, y: 64, w: 10, h: 16 },
    render: (sid) => {
      const s = useStore.getState().sessions.find(s => s.id === sid)
      return <ModeWidget sessionSource={s?.source} />
    },
  },
  {
    id: 'send', label: '发送按钮',
    defaultPos: { x: 87, y: 24, w: 6, h: 12 },
    // 由 renderWidget switch 注入 inputRef — 这里不需要 render
    render: () => null,
  },
  {
    id: 'attach', label: '附件按钮',
    defaultPos: { x: 94, y: 24, w: 4, h: 12 },
    render: () => null,
  },
]

// ── 位置默认值合并（向后兼容老 localStorage 缺失字段） ──────
function ensurePositions(positions: any): Record<string, { x: number; y: number; w: number; h: number }> {
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
  const rawPositions = useStore(s => s.ccPositions)
  const positions = useMemo(() => ensurePositions(rawPositions), [rawPositions])
  const editMode = useStore(s => s.ccEditMode)
  const ccVariant = useStore(s => s.ccVariant) || 'terminal'
  const ccBg = useStore(s => s.ccBg) || 'transparent'
  const ccBgImage = useStore(s => s.ccBgImage) || ''

  const inputRef = useRef<{ send: () => void; attachFile: () => void }>(null)
  const [selected, setSelected] = useState<string | null>(null)

  // 把 inputRef 转给 SendWidget / AttachWidget
  const renderWidget = (id: string) => {
    const def = WIDGET_REGISTRY.find(w => w.id === id)
    if (!def) return null
    if (!editMode && hidden.includes(id)) return null
    // CLI 模式下 send/attach 无意义（InputBar 通过 Enter 发送）— 非编辑状态自动隐藏
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

    const rawPos = positions[id] || def.defaultPos
    // CLI 模式下强制修正布局：input 占满整宽，status/model/mode 对齐到下方
    // 不依赖 localStorage 旧值 — 旧值可能是 non-CLI 的预设
    const CLI_OVERRIDES: Record<string, { x:number;y:number;w:number;h:number }> = {
      input:   { x: 1,  y: 1,  w: 98, h: 60 },
      context: { x: 1,  y: 68, w: 54, h: 16 },
      model:   { x: 57, y: 68, w: 28, h: 16 },
      mode:    { x: 87, y: 68, w: 12, h: 16 },
    }
    const pos = (!editMode && inputMode === 'cli' && CLI_OVERRIDES[id])
      ? CLI_OVERRIDES[id]
      : rawPos
    return (
      <EditableWidget
        key={id} id={id} pos={pos} editMode={editMode}
        isHidden={hidden.includes(id)}
        bodyRef={ccBodyRef}
        selected={selected === id}
        onSelect={() => setSelected(id)}
      >
        {body}
      </EditableWidget>
    )
  }

  const ccBodyRef = useRef<HTMLDivElement>(null)

  // 整体高度拖拽
  const onHeightDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = ccHeight
    const onMove = (ev: MouseEvent) => {
      useStore.setState({ ccHeight: Math.max(80, Math.min(400, startH + startY - ev.clientY)) } as any)
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [ccHeight])

  // Escape 退出编辑模式
  useEffect(() => {
    if (!editMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selected) setSelected(null)
        else useStore.setState({ ccEditMode: false } as any)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editMode, selected])

  return (
    <div className={`control-center ${inputMode === 'cli' ? 'cli-mode' : ''} ${editMode ? 'cc-editing' : ''} cc-variant-${ccVariant}`}
      style={{ '--cc-height': `${ccHeight}px`, '--cc-bg-height': `${ccBgHeight}px`, '--cc-bg': ccBg, '--cc-bg-image': ccBgImage ? `url(${ccBgImage})` : 'none' } as React.CSSProperties}>
      {editMode && (
        <div className="cc-edit-hdr" onMouseDown={onHeightDrag}>
          <div className="cc-edit-hdr-bar" />
          <span className="cc-edit-hdr-label">{ccHeight}px</span>
        </div>
      )}
      <div className="cc-bg" />
      <div className="cc-body" ref={ccBodyRef}>
        {WIDGET_REGISTRY.map(w => renderWidget(w.id))}
      </div>
      {editMode && selected && <PropertyPanel id={selected} onClose={() => setSelected(null)} onExit={() => { useStore.setState({ ccEditMode: false } as any); setSelected(null) }} />}
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

function EditableWidget({ id, pos, editMode, isHidden, children, bodyRef, selected, onSelect }: {
  id: string
  pos: { x: number; y: number; w: number; h: number }
  editMode: boolean
  isHidden: boolean
  children: React.ReactNode
  bodyRef: React.RefObject<HTMLDivElement | null>
  selected: boolean
  onSelect: () => void
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
    const rect = body.getBoundingClientRect()
    const startX = e.clientX, startY = e.clientY
    const start = useStore.getState().ccPositions?.[id] || pos
    const onMove = (ev: PointerEvent) => {
      const dxPct = ((ev.clientX - startX) / rect.width) * 100
      const dyPct = ((ev.clientY - startY) / rect.height) * 100
      const cp = useStore.getState().ccPositions || {}
      const cur = cp[id] || start
      const nx = Math.max(0, Math.min(100 - cur.w, start.x + dxPct))
      const ny = Math.max(0, Math.min(100 - cur.h, start.y + dyPct))
      useStore.setState({ ccPositions: { ...cp, [id]: { ...cur, x: nx, y: ny } } } as any)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const handleResizePointerDown = (e: React.PointerEvent) => {
    if (!editMode) return
    e.stopPropagation()
    e.preventDefault()
    const body = bodyRef.current; if (!body) return
    const rect = body.getBoundingClientRect()
    const startX = e.clientX, startY = e.clientY
    const start = useStore.getState().ccPositions?.[id] || pos
    const onMove = (ev: PointerEvent) => {
      const dwPct = ((ev.clientX - startX) / rect.width) * 100
      const dhPct = ((ev.clientY - startY) / rect.height) * 100
      const cp = useStore.getState().ccPositions || {}
      const cur = cp[id] || start
      const nw = Math.max(3, Math.min(100 - cur.x, start.w + dwPct))
      const nh = Math.max(3, Math.min(100 - cur.y, start.h + dhPct))
      useStore.setState({ ccPositions: { ...cp, [id]: { ...cur, w: nw, h: nh } } } as any)
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
      className={`cc-widget ${editMode ? 'cc-edit' : ''} ${editMode && isHidden ? 'cc-hidden' : ''} ${selected ? 'cc-selected' : ''}`}
      style={{ left: `${pos.x}%`, top: `${pos.y}%`, width: `${pos.w}%`, height: `${pos.h}%` }}
      onPointerDown={editMode ? handleWidgetPointerDown : undefined}
    >
      {children}
      {editMode && <>
        <div className="cc-edit-rsz" onPointerDown={handleResizePointerDown} />
        <VisibilityToggle id={id} />
        <TypeToggle id={id} />
      </>}
    </div>
  )
}

// 编辑控件上的 handle（resize/visibility/type）跳过 widget 拖拽
function isControlHandle(el: HTMLElement | null): boolean {
  if (!el) return false
  return !!el.closest('.cc-edit-rsz, .cc-edit-vis, .cc-edit-type')
}

// ───────────────────────────────────────────────────────────────
// WidgetToolbar：编辑模式下浮在画布底部，显示「增删控件」+ 重置
// ───────────────────────────────────────────────────────────────

function WidgetToolbar({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const hidden = useStore(s => s.ccHidden || [])
  const positions = useStore(s => s.ccPositions)
  const u = useStore(s => s.updateTheme)

  const reset = () => {
    const fresh: any = {}
    for (const w of WIDGET_REGISTRY) fresh[w.id] = w.defaultPos
    useStore.setState({ ccPositions: fresh } as any)
  }

  const toggleHide = (id: string) => {
    const h = useStore.getState().ccHidden || []
    const next = h.includes(id) ? h.filter(x => x !== id) : [...h, id]
    useStore.setState({ ccHidden: next } as any)
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
      <button className="cc-edit-toolbar-btn danger" onClick={() => { useStore.setState({ ccEditMode: false } as any); onSelect(null) }}>退出编辑</button>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────
// PropertyPanel — 选中控件的属性编辑面板
// ───────────────────────────────────────────────────────────────

function PropertyPanel({ id, onClose, onExit }: { id: string; onClose: () => void; onExit: () => void }) {
  const pos = useStore(s => (s.ccPositions || {})[id]) || { x: 0, y: 0, w: 10, h: 10 }
  const all = useStore(s => s.ccPositions || {})
  const u = useStore(s => s.updateTheme)
  const theme = useStore(s => s as any)
  const labels: Record<string, string> = {
    input: '输入栏', context: '上下文', model: '模型',
    mode: '权限模式', send: '发送按钮', attach: '附件按钮',
  }

  const up = (k: string, v: any) => u({ [k]: v } as any)
  const upPos = (k: string, v: number) => u({ ccPositions: { ...all, [id]: { ...pos, [k]: v } } } as any)

  return (
    <div className="cc-prop-panel">
      <div className="cc-prop-header">
        <span>{labels[id] || id}</span>
        <button onClick={onClose}>✕</button>
      </div>
      <div className="cc-prop-body">
        <div className="cc-prop-sec">位置 & 大小</div>
        <div className="cc-prop-field"><label>X 坐标</label><input type="number" value={Math.round(pos.x)} onChange={v => upPos('x', +v.target.value)} className="set-num" /><span>%</span></div>
        <div className="cc-prop-field"><label>Y 坐标</label><input type="number" value={Math.round(pos.y)} onChange={v => upPos('y', +v.target.value)} className="set-num" /><span>%</span></div>
        <div className="cc-prop-field"><label>宽度</label><input type="number" value={Math.round(pos.w)} onChange={v => upPos('w', Math.max(3, +v.target.value))} className="set-num" /><span>%</span></div>
        <div className="cc-prop-field"><label>高度</label><input type="number" value={Math.round(pos.h)} onChange={v => upPos('h', Math.max(3, +v.target.value))} className="set-num" /><span>%</span></div>

        {id === 'input' && <>
          <div className="cc-prop-sec">输入栏设置</div>
          <div className="cc-prop-field"><label>背景色</label><ColorPopover value={theme.inputBg || ''} onChange={v => up('inputBg', v)} /></div>
          <div className="cc-prop-field"><label>文字色</label><ColorPopover value={theme.inputTextColor || ''} onChange={v => up('inputTextColor', v)} /></div>
          <div className="cc-prop-field"><label>字号</label><input type="number" value={theme.inputFontSize} onChange={v => up('inputFontSize', +v.target.value)} className="set-num" min={12} max={22} /></div>
          <div className="cc-prop-field"><label>最小高</label><input type="number" value={theme.inputMinHeight} onChange={v => up('inputMinHeight', +v.target.value)} className="set-num" min={36} max={120} /></div>
          <div className="cc-prop-field"><label>模式</label>
            <div className="set-preset-row">
              <button className={`set-preset-chip ${theme.inputMode === 'default' ? 'active' : ''}`} onClick={() => up('inputMode', 'default')}>默认</button>
              <button className={`set-preset-chip ${theme.inputMode === 'cli' ? 'active' : ''}`} onClick={() => up('inputMode', 'cli')}>CLI</button>
            </div>
          </div>
          {theme.inputMode === 'cli' && <>
            <div className="cc-prop-field"><label>线宽</label><input type="number" value={theme.cliLineWidth} onChange={v => up('cliLineWidth', +v.target.value)} className="set-num" min={1} max={6} /></div>
            <div className="cc-prop-field"><label>线色</label><ColorPopover value={theme.cliLineColor || ''} onChange={v => up('cliLineColor', v)} /></div>
            <div className="cc-prop-field"><label>行距</label><input type="number" value={(theme as any).cliLinePadding ?? 6} onChange={v => up('cliLinePadding', +v.target.value)} className="set-num" min={0} max={24} /></div>
          </>}
        </>}

        {id === 'context' && <>
          <div className="cc-prop-sec">上下文显示</div>
          <div className="cc-prop-field"><label>背景色</label><ColorPopover value={theme.statusBg || ''} onChange={v => up('statusBg', v)} /></div>
          <div className="cc-prop-field"><label>仪表类型</label>
            <div className="set-preset-row">
              {(['wave', 'bar', 'numeric'] as const).map(s => (
                <button key={s} className={`set-preset-chip ${theme.ccStyle === s ? 'active' : ''}`} onClick={() => up('ccStyle', s)}>
                  {s === 'wave' ? '心电图' : s === 'bar' ? '柱状' : '数值'}
                </button>
              ))}
            </div>
          </div>
          <div className="cc-prop-field"><label>宽度</label><input type="number" value={theme.ekgWidth} onChange={v => up('ekgWidth', +v.target.value)} className="set-num" min={80} max={400} /></div>
          <div className="cc-prop-field"><label>字号</label><input type="number" value={theme.ekgFontSize} onChange={v => up('ekgFontSize', +v.target.value)} className="set-num" min={12} max={22} /></div>
          {theme.ccStyle === 'wave' && <>
            <div className="cc-prop-field"><label>绿色</label><ColorPopover value={theme.ekgGreen || ''} onChange={v => up('ekgGreen', v)} /></div>
            <div className="cc-prop-field"><label>黄色</label><ColorPopover value={theme.ekgYellow || ''} onChange={v => up('ekgYellow', v)} /></div>
            <div className="cc-prop-field"><label>红色</label><ColorPopover value={theme.ekgRed || ''} onChange={v => up('ekgRed', v)} /></div>
            <div className="cc-prop-field"><label>线宽</label><input type="number" value={theme.ekgLineWidth} onChange={v => up('ekgLineWidth', +v.target.value)} className="set-num" min={2} max={20} /></div>
            <div className="cc-prop-field"><label>振幅</label><input type="number" value={theme.ekgAmplitudeMax} onChange={v => up('ekgAmplitudeMax', +v.target.value)} className="set-num" min={5} max={30} /></div>
            <div className="cc-prop-field"><label>波速基</label><input type="number" value={theme.ekgSpeedBase} onChange={v => up('ekgSpeedBase', +v.target.value)} className="set-num" min={0} max={3} step={0.1} /></div>
            <div className="cc-prop-field"><label>波速最</label><input type="number" value={theme.ekgSpeedMax} onChange={v => up('ekgSpeedMax', +v.target.value)} className="set-num" min={0} max={5} step={0.1} /></div>
          </>}
          <div className="cc-prop-field"><label>显示模式</label>
            <div className="set-preset-row">
              <button className={`set-preset-chip ${theme.tokenDisplay === 'ekg' ? 'active' : ''}`} onClick={() => up('tokenDisplay', 'ekg')}>ECG</button>
              <button className={`set-preset-chip ${theme.tokenDisplay === 'numeric' ? 'active' : ''}`} onClick={() => up('tokenDisplay', 'numeric')}>数字</button>
            </div>
          </div>
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

// ───────────────────────────────────────────────────────────────
// 内嵌控件：单 widget 上的显隐 / 类型切换
// ───────────────────────────────────────────────────────────────

function VisibilityToggle({ id }: { id: string }) {
  const hidden = useStore(s => (s.ccHidden || []).includes(id))
  const u = useStore(s => s.updateTheme)
  return (
    <div className="cc-edit-vis" onClick={e => {
      e.stopPropagation()
      const h = useStore.getState().ccHidden || []
      u({ ccHidden: hidden ? h.filter(x => x !== id) : [...h, id] } as any)
    }} title={hidden ? '显示' : '隐藏'}>
      {hidden ? '⊙' : '⊘'}
    </div>
  )
}

function TypeToggle({ id }: { id: string }) {
  const inputMode = useStore(s => s.inputMode)
  const ccStyle = useStore(s => s.ccStyle)
  const modelVariant = useStore(s => s.modelVariant) || 'dropdown'
  const modeVariant = useStore(s => s.modeVariant) || 'pill'
  const sendVariant = useStore(s => s.sendVariant) || 'icon'
  const attachVariant = useStore(s => s.attachVariant) || 'icon'
  const u = useStore(s => s.updateTheme)

  if (id === 'input') {
    return (
      <div className="cc-edit-type" onClick={e => {
        e.stopPropagation()
        u({ inputMode: inputMode === 'cli' ? 'default' : 'cli' } as any)
      }} title="切换输入风格">{inputMode === 'cli' ? 'CLI' : 'Def'}</div>
    )
  }
  if (id === 'context') {
    const styles = ['wave', 'bar', 'numeric']
    const idx = styles.indexOf(ccStyle || 'wave')
    return (
      <div className="cc-edit-type" onClick={e => {
        e.stopPropagation()
        u({ ccStyle: styles[(idx + 1) % styles.length] } as any)
      }} title="切换显示类型">{ccStyle || 'wave'}</div>
    )
  }
  if (id === 'model') {
    const variants = ['dropdown', 'minimal', 'badge']
    const idx = variants.indexOf(modelVariant)
    return (
      <div className="cc-edit-type" onClick={e => {
        e.stopPropagation()
        u({ modelVariant: variants[(idx + 1) % variants.length] } as any)
      }} title="切换外观">{modelVariant}</div>
    )
  }
  if (id === 'mode') {
    const variants = ['pill', 'badge', 'minimal']
    const idx = variants.indexOf(modeVariant)
    return (
      <div className="cc-edit-type" onClick={e => {
        e.stopPropagation()
        u({ modeVariant: variants[(idx + 1) % variants.length] } as any)
      }} title="切换外观">{modeVariant}</div>
    )
  }
  if (id === 'send') {
    const variants = ['icon', 'square', 'minimal']
    const idx = variants.indexOf(sendVariant)
    return (
      <div className="cc-edit-type" onClick={e => {
        e.stopPropagation()
        u({ sendVariant: variants[(idx + 1) % variants.length] } as any)
      }} title="切换外观">{sendVariant}</div>
    )
  }
  if (id === 'attach') {
    const variants = ['icon', 'square', 'minimal']
    const idx = variants.indexOf(attachVariant)
    return (
      <div className="cc-edit-type" onClick={e => {
        e.stopPropagation()
        u({ attachVariant: variants[(idx + 1) % variants.length] } as any)
      }} title="切换外观">{attachVariant}</div>
    )
  }
  return null
}