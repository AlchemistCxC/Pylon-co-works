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
    <div className={`control-center ${inputMode === 'cli' ? 'cli-mode' : ''} ${editMode ? 'cc-editing' : ''} cc-variant-${useStore.getState().ccVariant || 'pill'}`}
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
      {editMode && selected && <PropertyPanel id={selected} onClose={() => setSelected(null)} onExit={() => { useStore.setState({ ccEditMode: false } as any); setSelected(null) }} />}
      {editMode && !selected && (
        <div className="cc-edit-toolbar">
          <button className="ps-btn" onClick={() => useStore.setState({ ccEditMode: false } as any)}>退出</button>
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

function ColorSwatch({ value, onChange }: { value:string; onChange:(v:string)=>void }) {
  const ref = useRef<HTMLInputElement>(null)
  return <>
    <div className="set-swatch" style={{background:value||'transparent'}} onClick={()=>ref.current?.click()}/>
    <input ref={ref} type="color" value={value||''} onChange={e=>onChange(e.target.value)} style={{display:'none'}}/>
  </>
}

function PropertyPanel({ id, onClose, onExit }: { id: string; onClose: () => void; onExit: () => void }) {
  const pos = useStore(s => s.ccPositions[id]) || { x:0,y:0,w:10,h:10 }
  const all = useStore(s => s.ccPositions) || {}
  const u = useStore(s => s.updateTheme)
  const theme = useStore() as any
  const labels: Record<string,string> = { input:'输入栏', context:'上下文信息', model:'模型选择', mode:'权限模式', send:'发送按钮', attach:'附件按钮' }

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
        <div className="cc-prop-field"><label>X 坐标</label><input type="number" value={pos.x} onChange={v=>upPos('x',+v.target.value)} className="set-num"/><span>%</span></div>
        <div className="cc-prop-field"><label>Y 坐标</label><input type="number" value={pos.y} onChange={v=>upPos('y',+v.target.value)} className="set-num"/><span>%</span></div>
        <div className="cc-prop-field"><label>宽度</label><input type="number" value={pos.w} onChange={v=>upPos('w',Math.max(5,+v.target.value))} className="set-num"/><span>%</span></div>
        <div className="cc-prop-field"><label>高度</label><input type="number" value={pos.h} onChange={v=>upPos('h',Math.max(5,+v.target.value))} className="set-num"/><span>%</span></div>

        {id === 'input' && <>
          <div className="cc-prop-sec">输入栏设置</div>
          <div className="cc-prop-field"><label>背景色</label><ColorSwatch value={theme.inputBg||''} onChange={v=>up('inputBg',v)}/></div>
          <div className="cc-prop-field"><label>文字色</label><ColorSwatch value={theme.inputTextColor||''} onChange={v=>up('inputTextColor',v)}/></div>
          <div className="cc-prop-field"><label>字号</label><input type="number" value={theme.inputFontSize} onChange={v=>up('inputFontSize',+v.target.value)} className="set-num" min={12} max={22}/></div>
          <div className="cc-prop-field"><label>最小高</label><input type="number" value={theme.inputMinHeight} onChange={v=>up('inputMinHeight',+v.target.value)} className="set-num" min={36} max={120}/></div>
          <div className="cc-prop-field"><label>模式</label>
            <div className="set-preset-row">
              <button className={`set-preset-chip ${theme.inputMode==='default'?'active':''}`} onClick={()=>up('inputMode','default')}>输入框</button>
              <button className={`set-preset-chip ${theme.inputMode==='cli'?'active':''}`} onClick={()=>up('inputMode','cli')}>CLI</button>
            </div>
          </div>
          {theme.inputMode==='cli' && <>
            <div className="cc-prop-field"><label>线宽</label><input type="number" value={theme.cliLineWidth} onChange={v=>up('cliLineWidth',+v.target.value)} className="set-num" min={1} max={6}/></div>
            <div className="cc-prop-field"><label>线色</label><ColorSwatch value={theme.cliLineColor||''} onChange={v=>up('cliLineColor',v)}/></div>
          </>}
        </>}

        {id === 'context' && <>
          <div className="cc-prop-sec">上下文显示</div>
          <div className="cc-prop-field"><label>背景色</label><ColorSwatch value={theme.statusBg||''} onChange={v=>up('statusBg',v)}/></div>
          <div className="cc-prop-field"><label>仪表类型</label>
            <div className="set-preset-row">
              {(['wave','bar','numeric'] as const).map(s=>(
                <button key={s} className={`set-preset-chip ${theme.ccStyle===s?'active':''}`} onClick={()=>up('ccStyle',s)}>
                  {s==='wave'?'心电图':s==='bar'?'柱状':'数值'}
                </button>
              ))}
            </div>
          </div>
          <div className="cc-prop-field"><label>宽度</label><input type="number" value={theme.ekgWidth} onChange={v=>up('ekgWidth',+v.target.value)} className="set-num" min={120} max={400}/></div>
          <div className="cc-prop-field"><label>字号</label><input type="number" value={theme.ekgFontSize} onChange={v=>up('ekgFontSize',+v.target.value)} className="set-num" min={12} max={22}/></div>
          {theme.ccStyle==='wave' && <>
            <div className="cc-prop-field"><label>绿色</label><ColorSwatch value={theme.ekgGreen||''} onChange={v=>up('ekgGreen',v)}/></div>
            <div className="cc-prop-field"><label>黄色</label><ColorSwatch value={theme.ekgYellow||''} onChange={v=>up('ekgYellow',v)}/></div>
            <div className="cc-prop-field"><label>红色</label><ColorSwatch value={theme.ekgRed||''} onChange={v=>up('ekgRed',v)}/></div>
            <div className="cc-prop-field"><label>线宽</label><input type="number" value={theme.ekgLineWidth} onChange={v=>up('ekgLineWidth',+v.target.value)} className="set-num" min={2} max={20}/></div>
            <div className="cc-prop-field"><label>振幅</label><input type="number" value={theme.ekgAmplitudeMax} onChange={v=>up('ekgAmplitudeMax',+v.target.value)} className="set-num" min={5} max={30}/></div>
            <div className="cc-prop-field"><label>波速基</label><input type="number" value={theme.ekgSpeedBase} onChange={v=>up('ekgSpeedBase',+v.target.value)} className="set-num" min={0} max={3} step={0.1}/></div>
            <div className="cc-prop-field"><label>波速最</label><input type="number" value={theme.ekgSpeedMax} onChange={v=>up('ekgSpeedMax',+v.target.value)} className="set-num" min={0} max={5} step={0.1}/></div>
            <div className="cc-prop-field"><label>定端</label><ColorSwatch value={theme.ekgLeftColor||''} onChange={v=>up('ekgLeftColor',v)}/></div>
            <div className="cc-prop-field"><label>动端</label><ColorSwatch value={theme.ekgMovingColor||''} onChange={v=>up('ekgMovingColor',v)}/></div>
            <div className="cc-prop-field"><label>消耗</label><ColorSwatch value={theme.ekgConsumedColor||''} onChange={v=>up('ekgConsumedColor',v)}/></div>
          </>}
          <div className="cc-prop-field"><label>显示模式</label>
            <div className="set-preset-row">
              <button className={`set-preset-chip ${theme.tokenDisplay==='ekg'?'active':''}`} onClick={()=>up('tokenDisplay','ekg')}>ECG</button>
              <button className={`set-preset-chip ${theme.tokenDisplay==='numeric'?'active':''}`} onClick={()=>up('tokenDisplay','numeric')}>数字</button>
            </div>
          </div>
        </>}

        {id === 'model' && <>
          <div className="cc-prop-sec">模型胶囊</div>
          <div className="cc-prop-field"><label>胶囊背景</label><ColorSwatch value={theme.pillBg||''} onChange={v=>up('pillBg',v)}/></div>
          <div className="cc-prop-field"><label>胶囊文字</label><ColorSwatch value={theme.pillText||''} onChange={v=>up('pillText',v)}/></div>
          <div className="cc-prop-field"><label>Prism ON</label><ColorSwatch value={theme.prismOnColor||''} onChange={v=>up('prismOnColor',v)}/></div>
        </>}

        {id === 'mode' && <>
          <div className="cc-prop-sec">权限</div>
          <div style={{fontSize:13,color:'var(--text-dim)',padding:'6px 0'}}>
            模式切换由 Agent 控制
          </div>
        </>}
      </div>
      <div className="cc-prop-footer">
        <button className="ps-btn sm" onClick={onExit}>退出自定义</button>
      </div>
    </div>
  )
}
