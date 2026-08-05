import { useState } from 'react'
import { useWorkspaceStore } from '../../workspaceStore'
import { transitionContextPanel, createContextPanelState, type ContextPanelState, type ContextPanelMode } from './contextPanelTypes.ts'
import type { SheetContext } from '../../workspace-sheets/sheetTypes'
import './ContextPanel.css'

/**
 * ContextPanel — 搜索/关联两模式右栏壳（W1-04，F2-F）。
 *
 * 默认折叠读 workspaceStore.rightPanelCollapsed（W1-01 布局字段）；open 时展示
 * 模式切换 + 当前模式内容壳。搜索/关联的具体数据在 W2-12 接入（agent 会话内搜索、
 * FileSheet 关联文件）。旧 RightPanel 暂留不删（W2-12 退役）。
 */

const MODE_LABELS: Record<ContextPanelMode, string> = {
  search: '搜索',
  relations: '关联',
}

export default function ContextPanel({ ctx }: { ctx: SheetContext }) {
  const rightPanelCollapsed = useWorkspaceStore(s => s.rightPanelCollapsed)
  const setRightPanelCollapsed = useWorkspaceStore(s => s.setRightPanelCollapsed)
  const [state, setState] = useState<ContextPanelState>(() => createContextPanelState(rightPanelCollapsed))

  // 折叠由 workspaceStore 驱动（slot 已按 collapsed 决定挂载）；此处状态机保持 open/mode
  if (rightPanelCollapsed) return null

  const open = state.status === 'open' ? state : { status: 'open' as const, mode: 'search' as const }
  const switchMode = (mode: ContextPanelMode) => setState(previous => transitionContextPanel(previous, { type: 'set-mode', mode }))
  const collapse = () => {
    setState(previous => transitionContextPanel(previous, { type: 'collapse' }))
    setRightPanelCollapsed(true)
  }

  return (
    <aside className="context-panel" style={{ '--right-panel-inset': `${ctx.rightInset}px` } as React.CSSProperties}>
      <div className="context-panel-head">
        {(Object.keys(MODE_LABELS) as ContextPanelMode[]).map(mode => (
          <button
            key={mode}
            type="button"
            className={`context-panel-mode ${open.mode === mode ? 'active' : ''}`}
            onClick={() => switchMode(mode)}
          >
            {MODE_LABELS[mode]}
          </button>
        ))}
        <button type="button" className="context-panel-collapse" onClick={collapse} title="折叠右栏">»</button>
      </div>
      <div className="context-panel-body">
        {open.mode === 'search'
          ? <div className="context-panel-placeholder">会话内搜索（W2-12 接入）</div>
          : <div className="context-panel-placeholder">关联文件（W2-12 接入）</div>}
      </div>
    </aside>
  )
}
