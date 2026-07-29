import type { PanelStatusProps } from './rightPanelTypes'

export default function PanelStatus({ kind, title, detail, retry }: PanelStatusProps) {
  return (
    <div className={`panel-status panel-status-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="panel-status-title">{title}</div>
      {detail && <div className="panel-status-detail">{detail}</div>}
      {retry && <button type="button" className="panel-status-retry" onClick={retry}>重试</button>}
    </div>
  )
}
