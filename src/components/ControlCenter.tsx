import { useRef, useState, useCallback } from 'react'
import { useStore } from '../store'
import InputBar from './chat/InputBar'
import StatusBar from './chat/StatusBar'
import ModelWidget from './chat/ModelWidget'
import ModeWidget from './chat/ModeWidget'
import SendWidget from './chat/SendWidget'
import AttachWidget from './chat/AttachWidget'
import './ControlCenter.css'

interface Props { sessionId: string | null }

const ALL_WIDGETS = ['input', 'context', 'model', 'mode', 'send', 'attach']

export default function ControlCenter({ sessionId }: Props) {
  const ccHeight = useStore(s => s.ccHeight) || 120
  const ccBgHeight = useStore(s => s.ccBgHeight ?? ccHeight)
  const inputMode = useStore(s => s.inputMode)
  const hidden = useStore(s => s.ccHidden || [])
  const positions = useStore(s => s.ccPositions) || {}
  const editMode = useStore(s => s.ccEditMode)
  const u = useStore(s => s.updateTheme)

  const inputRef = useRef<{ send: () => void; attachFile: () => void }>(null)
  const isSplit = editMode && (!!positions['send'] || !!positions['attach'])
  const [selected, setSelected] = useState<string | null>(null)

  const renderWidget = (id: string) => {
    if (!editMode && hidden.includes(id)) return null
    const pos = positions[id]
    let widget: React.ReactNode = null
    switch (id) {
      case 'input':
        widget = <InputBar ref={inputRef} sessionId={sessionId} split={isSplit} />
        break
      case 'context':
        widget = <StatusBar />
        break
      case 'model':
        widget = <ModelWidget />
        break
      case 'mode':
        widget = <ModeWidget />
        break
      case 'send':
        widget = <SendWidget onClick={() => inputRef.current?.send()} />
        break
      case 'attach':
        widget = <AttachWidget onClick={() => inputRef.current?.attachFile()} />
        break
      default: return null
    }
    if (!pos) return null
    return (
      <EditableWidget key={id} id={id} pos={pos} editMode={editMode} hidden={hidden.includes(id)} bodyRef={ccBodyRef}
        selected={selected} onSelect={() => setSelected(id)}>
        {widget}
      </EditableWidget>
    )
  }

  const ccBodyRef = useRef<HTMLDivElement>(null)
  const onHeightDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = ccHeight
    const onMove = (ev: MouseEvent) => { u({ ccHeight: Math.max(80, Math.min(400, startH + startY - ev.clientY)) } as any) }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [ccHeight, u])

  return (
    <div className={`control-center ${inputMode === 'cli' ? 'cli-mode' : ''} ${editMode ? 'cc-editing' : ''}`}
      style={{ '--cc-height': `${ccHeight}px`, '--cc-bg-height': `${ccBgHeight}px` } as React.CSSProperties}>
      {editMode && (
        <div className="cc-edit-hdr" onMouseDown={onHeightDrag}>
          <div className="cc-edit-hdr-bar" />
          <span className="cc-edit-hdr-label">{ccHeight}px</span>
        </div>
      )}
      <div className="cc-bg" />
      <div className="cc-body" ref={ccBodyRef}>
        {(editMode ? ALL_WIDGETS : ['input', 'context', 'model', 'mode']).map(renderWidget)}
      </div>
      {editMode && selected && <PropertyPanel id={selected} />}
      {editMode && (
        <div className="cc-edit-toolbar">
          <button className="ps-btn sm" onClick={() => u({ ccEditMode: false } as any)}>退出</button>
        </div>
      )}
    </div>
  )
}

// ── EditableWidget: drag + resize in edit mode ──

function EditableWidget({ id, pos, editMode, hidden: isHidden, children, bodyRef, selected, onSelect }: {
  id: string; pos: {x:number;y:number;w:number;h:number}; editMode: boolean; hidden: boolean;
  children: React.ReactNode; bodyRef: React.RefObject<HTMLDivElement | null>;
  selected: string | null; onSelect: () => void;
}) {
  const u = useStore(s => s.updateTheme)
  const positions = useStore(s => s.ccPositions) || {}

  const dragStart = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null)
  const resizeStart = useRef<{ x: number; y: number; sw: number; sh: number } | null>(null)

  const onWidgetMouseDown = (e: React.MouseEvent) => {
    if (!editMode || (e.target as HTMLElement).classList.contains('cc-edit-rsz')) return
    e.stopPropagation()
    const el = bodyRef.current; if (!el) return
    const rect = el.getBoundingClientRect()
    dragStart.current = { x: e.clientX, y: e.clientY, sx: pos.x, sy: pos.y }
    const onMove = (ev: MouseEvent) => {
      const d = dragStart.current!; if (!d) return
      const dx = ((ev.clientX - d.x) / rect.width) * 100
      const dy = ((ev.clientY - d.y) / rect.height) * 100
      const nx = Math.max(0, Math.min(100 - pos.w, d.sx + dx))
      const ny = Math.max(0, Math.min(100 - pos.h, d.sy + dy))
      const all = positions || {}
      u({ ccPositions: { ...all, [id]: { ...all[id], x: Math.round(nx), y: Math.round(ny) } } } as any)
    }
    const onUp = () => { dragStart.current = null; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const onResizeMouseDown = (e: React.MouseEvent) => {
    if (!editMode) return
    e.stopPropagation(); e.preventDefault()
    const el = bodyRef.current; if (!el) return
    const rect = el.getBoundingClientRect()
    resizeStart.current = { x: e.clientX, y: e.clientY, sw: pos.w, sh: pos.h }
    const onMove = (ev: MouseEvent) => {
      const d = resizeStart.current!; if (!d) return
      const dw = ((ev.clientX - d.x) / rect.width) * 100
      const dh = ((ev.clientY - d.y) / rect.height) * 100
      const nw = Math.max(5, Math.min(100 - pos.x, d.sw + dw))
      const nh = Math.max(5, Math.min(100 - pos.y, d.sh + dh))
      const all = positions || {}
      u({ ccPositions: { ...all, [id]: { ...all[id], w: Math.round(nw), h: Math.round(nh) } } } as any)
    }
    const onUp = () => { resizeStart.current = null; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div className={`cc-widget ${editMode ? 'cc-edit' : ''} ${editMode && isHidden ? 'cc-hidden' : ''} ${selected === id ? 'cc-selected' : ''}`}
      style={{ left: `${pos.x}%`, top: `${pos.y}%`, width: `${pos.w}%`, height: `${pos.h}%` }}
      onMouseDown={editMode ? (e) => { onWidgetMouseDown(e); onSelect() } : undefined}>
      {children}
      {editMode && <>
        <div className="cc-edit-rsz" onMouseDown={onResizeMouseDown} />
        <VisibilityToggle id={id} />
        <TypeToggle id={id} />
      </>}
    </div>
  )
}

function VisibilityToggle({ id }: { id: string }) {
  const hidden = useStore(s => (s.ccHidden || []).includes(id))
  const u = useStore(s => s.updateTheme)
  return (
    <div className="cc-edit-vis" onClick={e => { e.stopPropagation()
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
  const u = useStore(s => s.updateTheme)
  if (id === 'input') {
    const label = inputMode === 'cli' ? 'CLI' : 'Def'
    return (
      <div className="cc-edit-type" onClick={e => { e.stopPropagation()
        u({ inputMode: inputMode === 'cli' ? 'default' : 'cli' } as any)
      }} title="切换输入风格">{label}</div>
    )
  }
  if (id === 'context') {
    const styles = ['wave', 'bar', 'numeric']
    const idx = styles.indexOf(ccStyle || 'wave')
    const next = styles[(idx + 1) % styles.length]
    return (
      <div className="cc-edit-type" onClick={e => { e.stopPropagation()
        u({ ccStyle: next } as any)
      }} title="切换显示类型">{ccStyle || 'wave'}</div>
    )
  }
  return null
}

function PropertyPanel({ id }: { id: string }) {
  const pos = useStore(s => s.ccPositions[id]) || { x:0,y:0,w:10,h:10 }
  const all = useStore(s => s.ccPositions) || {}
  const u = useStore(s => s.updateTheme)
  const theme = useStore() as any
  const labels: Record<string,string> = { input:'输入栏', context:'上下文', model:'模型', mode:'模式', send:'发送', attach:'附件' }

  return (
    <div className="cc-prop-panel">
      <div className="cc-prop-title">{labels[id] || id}</div>

      {/* Position & size (all widgets) */}
      <div className="cc-prop-section">位置 & 大小</div>
      <div className="cc-prop-row"><span>X</span><input type="number" value={pos.x} onChange={v=>u({ccPositions:{...all,[id]:{...pos,x:+v.target.value}}} as any)}/><span>%</span></div>
      <div className="cc-prop-row"><span>Y</span><input type="number" value={pos.y} onChange={v=>u({ccPositions:{...all,[id]:{...pos,y:+v.target.value}}} as any)}/><span>%</span></div>
      <div className="cc-prop-row"><span>W</span><input type="number" value={pos.w} onChange={v=>u({ccPositions:{...all,[id]:{...pos,w:Math.max(5,+v.target.value)}}} as any)}/><span>%</span></div>
      <div className="cc-prop-row"><span>H</span><input type="number" value={pos.h} onChange={v=>u({ccPositions:{...all,[id]:{...pos,h:Math.max(5,+v.target.value)}}} as any)}/><span>%</span></div>

      {/* Input bar settings */}
      {id === 'input' && <>
        <div className="cc-prop-section">输入栏</div>
        <div className="cc-prop-row"><span>背景</span><input type="color" value={theme.inputBg} onChange={v=>u({inputBg:v.target.value} as any)}/></div>
        <div className="cc-prop-row"><span>文字色</span><input type="color" value={theme.inputTextColor} onChange={v=>u({inputTextColor:v.target.value} as any)}/></div>
        <div className="cc-prop-row"><span>字号</span><input type="number" value={theme.inputFontSize} onChange={v=>u({inputFontSize:+v.target.value} as any)} min={12} max={22}/></div>
        <div className="cc-prop-row"><span>最小高</span><input type="number" value={theme.inputMinHeight} onChange={v=>u({inputMinHeight:+v.target.value} as any)} min={36} max={120}/></div>
        <div className="cc-prop-row"><span>模式</span>
          <select value={theme.inputMode} onChange={v=>u({inputMode:v.target.value} as any)}>
            <option value="default">输入框</option><option value="cli">CLI</option>
          </select>
        </div>
        {theme.inputMode==='cli' && <>
          <div className="cc-prop-row"><span>线宽</span><input type="number" value={theme.cliLineWidth} onChange={v=>u({cliLineWidth:+v.target.value} as any)} min={1} max={6}/></div>
          <div className="cc-prop-row"><span>线色</span><input type="color" value={theme.cliLineColor} onChange={v=>u({cliLineColor:v.target.value} as any)}/></div>
        </>}
      </>}

      {/* Context / status bar settings */}
      {id === 'context' && <>
        <div className="cc-prop-section">上下文</div>
        <div className="cc-prop-row"><span>背景</span><input type="color" value={theme.statusBg} onChange={v=>u({statusBg:v.target.value} as any)}/></div>
        <div className="cc-prop-row"><span>仪表</span>
          <select value={theme.ccStyle} onChange={v=>u({ccStyle:v.target.value} as any)}>
            <option value="wave">心电图</option><option value="bar">柱状图</option><option value="numeric">数值</option>
          </select>
        </div>
        <div className="cc-prop-row"><span>宽</span><input type="number" value={theme.ekgWidth} onChange={v=>u({ekgWidth:+v.target.value} as any)} min={120} max={400}/></div>
        <div className="cc-prop-row"><span>字号</span><input type="number" value={theme.ekgFontSize} onChange={v=>u({ekgFontSize:+v.target.value} as any)} min={12} max={22}/></div>
        {theme.ccStyle==='wave' && <>
          <div className="cc-prop-row"><span>绿</span><input type="color" value={theme.ekgGreen} onChange={v=>u({ekgGreen:v.target.value} as any)}/></div>
          <div className="cc-prop-row"><span>黄</span><input type="color" value={theme.ekgYellow} onChange={v=>u({ekgYellow:v.target.value} as any)}/></div>
          <div className="cc-prop-row"><span>红</span><input type="color" value={theme.ekgRed} onChange={v=>u({ekgRed:v.target.value} as any)}/></div>
          <div className="cc-prop-row"><span>线宽</span><input type="number" value={theme.ekgLineWidth} onChange={v=>u({ekgLineWidth:+v.target.value} as any)} min={2} max={20}/></div>
          <div className="cc-prop-row"><span>振幅</span><input type="number" value={theme.ekgAmplitudeMax} onChange={v=>u({ekgAmplitudeMax:+v.target.value} as any)} min={5} max={30}/></div>
        </>}
        <div className="cc-prop-row"><span>显示</span>
          <select value={theme.tokenDisplay} onChange={v=>u({tokenDisplay:v.target.value} as any)}>
            <option value="ekg">ECG波形</option><option value="numeric">数字</option>
          </select>
        </div>
      </>}

      {/* Model widget */}
      {id === 'model' && <>
        <div className="cc-prop-section">模型</div>
        <div className="cc-prop-row"><span>胶囊BG</span><input type="color" value={theme.pillBg} onChange={v=>u({pillBg:v.target.value} as any)}/></div>
        <div className="cc-prop-row"><span>胶囊TXT</span><input type="color" value={theme.pillText} onChange={v=>u({pillText:v.target.value} as any)}/></div>
        <div className="cc-prop-row"><span>PrismON</span><input type="color" value={theme.prismOnColor} onChange={v=>u({prismOnColor:v.target.value} as any)}/></div>
      </>}

      {/* Mode widget */}
      {id === 'mode' && <>
        <div className="cc-prop-section">权限模式</div>
        <div style={{fontSize:12,color:'var(--text-dim)',padding:'4px 0'}}>
          当前: {theme.inputMode || 'default'}
        </div>
      </>}
    </div>
  )
}
