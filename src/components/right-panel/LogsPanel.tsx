import PanelStatus from './PanelStatus'
import type { LogEntry, LogsViewState } from './rightPanelTypes'
import './LogsPanel.css'

export interface LogsPanelProps {
  state: LogsViewState
}

function LogsList({ entries }: { entries: readonly LogEntry[] }) {
  return (
    <div className="logs-panel-list" role="list" aria-label="日志列表">
      {entries.map((entry) => (
        <div className="logs-panel-entry" key={entry.id} role="listitem">
          <time className="logs-panel-time" dateTime={entry.time}>{entry.time}</time>
          <span className={`logs-panel-level logs-panel-level-${entry.level}`}>{entry.level}</span>
          <span className="logs-panel-source">{entry.source}</span>
          <span className="logs-panel-message">{entry.message}</span>
        </div>
      ))}
    </div>
  )
}

export default function LogsPanel({ state }: LogsPanelProps) {
  if (state.status === 'no-session') {
    return <div className="panel-tab logs-panel"><PanelStatus kind="empty" title="暂无会话" detail="选择一个会话后查看日志" /></div>
  }

  if (state.status === 'unwired') {
    return <div className="panel-tab logs-panel"><PanelStatus kind="empty" title="日志尚未接入" detail={`等待日志数据（${state.scope.source}）`} /></div>
  }

  if (state.status === 'loading') {
    return (
      <div className="panel-tab logs-panel">
        <PanelStatus kind="loading" title="正在加载日志" detail={state.scope.source} />
        {state.view && state.view.entries.length > 0 && <LogsList entries={state.view.entries} />}
      </div>
    )
  }

  if (state.status === 'empty') {
    return (
      <div className="panel-tab logs-panel">
        <PanelStatus kind="empty" title="暂无日志" detail={state.scope.source} />
        <LogsList entries={state.view.entries} />
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="panel-tab logs-panel">
        <PanelStatus kind="error" title="日志加载失败" detail={state.message} />
        {state.view && state.view.entries.length > 0 && <LogsList entries={state.view.entries} />}
      </div>
    )
  }

  return <div className="panel-tab logs-panel"><LogsList entries={state.view.entries} /></div>
}
