import { useState } from 'react'
import { useStore } from '../store'
import './RightPanel.css'

type Tab = 'files' | 'prism' | 'rag' | 'logs'

const TABS: { key: Tab; label: string }[] = [
  { key: 'files', label: '文件' },
  { key: 'prism', label: 'Prism' },
  { key: 'rag', label: 'RAG' },
  { key: 'logs', label: '日志' },
]

export default function RightPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('files')

  return (
    <aside className="right-panel">
      <div className="right-header">
        <div className="right-tabs">
          {TABS.map(t => (
            <button key={t.key} className={`right-tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
        <button className="right-close" onClick={onClose}>✕</button>
      </div>

      <div className="right-body">
        {tab === 'files' && <FilesTab />}
        {tab === 'prism' && <PrismTab />}
        {tab === 'rag' && <RagTab />}
        {tab === 'logs' && <LogsTab />}
      </div>
    </aside>
  )
}

function FilesTab() {
  return (
    <div className="panel-tab">
      <div className="panel-path">G:\Project\prism\</div>
      <div className="panel-tree">
        <div className="tree-folder open">▾ src/</div>
        <div className="tree-file">  main.rs</div>
        <div className="tree-file">  lib.rs</div>
        <div className="tree-folder">▸ qq/</div>
        <div className="tree-folder">▸ docs/</div>
      </div>
    </div>
  )
}

function PrismTab() {
  return (
    <div className="panel-tab">
      <div className="panel-section">
        <div className="panel-section-title">激活 Blocks</div>
        <div className="panel-item"><span className="panel-dot ok"/> 角色卡 <span className="panel-meta">sys · +520t</span></div>
        <div className="panel-item"><span className="panel-dot ok"/> 场景: 酒馆 <span className="panel-meta">sys · +180t</span></div>
        <div className="panel-item"><span className="panel-dot ok"/> NPC对话规则 <span className="panel-meta">sys · +90t</span></div>
      </div>
      <div className="panel-section">
        <div className="panel-section-title">注入统计</div>
        <div className="panel-stat">当前注入 <strong>790</strong> tokens</div>
        <div className="panel-stat">Gate 命中 <strong>3</strong> 条</div>
        <div className="panel-stat">Prism <span className="panel-badge on">ON</span></div>
      </div>
    </div>
  )
}

function RagTab() {
  return (
    <div className="panel-tab">
      <div className="panel-empty">
        <div className="panel-empty-icon">📚</div>
        <div>知识库检索</div>
        <div className="panel-empty-hint">接入 ChromaDB / bge-m3 后</div>
        <div className="panel-empty-hint">显示匹配的知识库片段</div>
      </div>
    </div>
  )
}

function LogsTab() {
  return (
    <div className="panel-tab">
      <div className="panel-log-list">
        <div className="panel-log-item"><span className="panel-log-time">10:32:06</span> read_file — /tmp/prism.log</div>
        <div className="panel-log-item"><span className="panel-log-time">10:32:05</span> grep — "error" in log</div>
        <div className="panel-log-item"><span className="panel-log-time">10:31:58</span> bash — ls -la</div>
      </div>
    </div>
  )
}
