import { useState } from 'react'
import PanelStatus from './right-panel/PanelStatus'
import ReservedTab from './right-panel/ReservedTab'
import { RIGHT_PANEL_TABS } from './right-panel/RightPanelTabs'
import type { RightPanelTab } from './right-panel/rightPanelTypes'
import './RightPanel.css'

interface RightPanelProps {
  sessionId: string | null
  onClose: () => void
}

export default function RightPanel({ sessionId, onClose }: RightPanelProps) {
  const [tab, setTab] = useState<RightPanelTab>('workspace')

  return (
    <aside className="right-panel">
      <div className="right-header">
        <div className="right-tabs">
          {RIGHT_PANEL_TABS.map(item => (
            <button key={item.id} className={`right-tab ${tab === item.id ? 'active' : ''}`}
              onClick={() => setTab(item.id)}>{item.label}</button>
          ))}
        </div>
        <button className="right-close" onClick={onClose} aria-label="关闭右栏">✕</button>
      </div>

      <div className="right-body">
        {tab === 'workspace' && (
          <PanelStatus
            kind="empty"
            title={sessionId ? '工作区尚未接入' : '未选择会话'}
            detail={sessionId ? '工作区 API 尚未由后端提供。' : '选择一个会话后，这里将显示其工作区。'}
          />
        )}
        {tab === 'logs' && (
          <PanelStatus
            kind="empty"
            title="运行日志尚未接入"
            detail="RuntimeLogHub 和日志事件 API 尚未由后端提供。"
          />
        )}
        {tab === 'reserved-1' && <ReservedTab title="预留页面一" detail="此页面暂未定义功能。" />}
        {tab === 'reserved-2' && <ReservedTab title="预留页面二" detail="此页面暂未定义功能。" />}
      </div>
    </aside>
  )
}
