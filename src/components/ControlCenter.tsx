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
      <EditableWidget key={id} id={id} pos={pos} editMode={editMode} hidden={hidden.includes(id)} bodyRef={ccBodyRef}>
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
    </div>
  )
}

// ── EditableWidget: drag + resize in edit mode ──

function EditableWidget({ id, pos, editMode, hidden: isHidden, children, bodyRef }: {
  id: string; pos: {x:number;y:number;w:number;h:number}; editMode: boolean; hidden: boolean;
  children: React.ReactNode; bodyRef: React.RefObject<HTMLDivElement | null>
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
    <div className={`cc-widget ${editMode ? 'cc-edit' : ''} ${editMode && isHidden ? 'cc-hidden' : ''}`}
      style={{ left: `${pos.x}%`, top: `${pos.y}%`, width: `${pos.w}%`, height: `${pos.h}%` }}
      onMouseDown={onWidgetMouseDown}>
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
