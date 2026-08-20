import { useEffect, useRef } from 'react'
import type { SheetRecord } from './sheetTypes'

export interface WorkspaceMenuActions {
  onTogglePin: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onCloseRight: (id: string) => void
  onReopen: () => void
}

interface WorkspaceMenuProps extends WorkspaceMenuActions {
  sheet: SheetRecord | null
  canReopen: boolean
  open: boolean
  onCloseMenu: () => void
  className?: string
  /** fixed 定位坐标（跟随右键位置）；缺省回退 CSS 定位 */
  position?: { x: number; y: number } | null
}

export default function WorkspaceMenu({ sheet, canReopen, open, onCloseMenu, className = '', position, onTogglePin, onClose, onCloseOthers, onCloseRight, onReopen }: WorkspaceMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) onCloseMenu() }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onCloseMenu() }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown) }
  }, [open, onCloseMenu])
  if (!open) return null
  const run = (action: () => void) => { action(); onCloseMenu() }
  const disabled = !sheet
  return (
    <div ref={menuRef} className={`workspace-menu ${className}`} role="menu"
      style={position ? { position: 'fixed', left: position.x, top: position.y } : undefined}>
      <button type="button" role="menuitem" disabled={disabled} onClick={() => sheet && run(() => onTogglePin(sheet.id))}>{sheet?.pinned ? '取消固定 Sheet' : '固定 Sheet'}</button>
      <div className="workspace-menu-separator" />
      <button type="button" role="menuitem" disabled={disabled || Boolean(sheet?.pinned)} onClick={() => sheet && run(() => onClose(sheet.id))}>关闭当前 Sheet</button>
      <button type="button" role="menuitem" disabled={disabled} onClick={() => sheet && run(() => onCloseOthers(sheet.id))}>关闭其他 Sheet</button>
      <button type="button" role="menuitem" disabled={disabled} onClick={() => sheet && run(() => onCloseRight(sheet.id))}>关闭右侧 Sheet</button>
      <div className="workspace-menu-separator" />
      <button type="button" role="menuitem" disabled={!canReopen} onClick={() => run(onReopen)}>重开最近关闭的 Sheet</button>
    </div>
  )
}
