import { useEffect, useState } from 'react'
import { IS_TAURI } from '../../infrastructure/tauri/env'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { clearWindowSize } from '../../windowSizePersistence'
import { Row } from '../../themeFieldRenderer.tsx'

function WindowSizeRow() {
  const [size, setSize] = useState('—')
  useEffect(() => {
    if (!IS_TAURI) return
    let cancelled = false
    getCurrentWindow().outerSize().then(({ width, height }) => {
      if (!cancelled) setSize(`${width}×${height}`)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  const reset = () => {
    getCurrentWindow().setSize(new PhysicalSize(1200, 800)).catch(() => {})
    clearWindowSize(localStorage)
  }
  return (
    <Group title="窗口">
      <Row label="当前尺寸"><span className="set-val" style={{ width: 'auto' }}>{size} px</span></Row>
      <div className="set-hint">拖动窗口边框后自动记忆尺寸，下次启动恢复</div>
      <div className="set-preset-row">
        <button type="button" className="ps-btn sm" onClick={reset}>重置为默认 1200×800</button>
      </div>
    </Group>
  )
}

export default WindowSizeRow

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="set-group">
      <button type="button" className="set-group-title" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="set-group-arrow">{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && children}
    </div>
  )
}
