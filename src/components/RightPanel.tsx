import { useState } from 'react'
import './RightPanel.css'

type Tab = 'files' | 'prism' | 'rag' | 'logs'

const TABS: { key: Tab; label: string }[] = [
  { key: 'files', label: 'Files' },
  { key: 'prism', label: 'Prism' },
  { key: 'rag', label: 'RAG' },
  { key: 'logs', label: 'Logs' },
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
        <div className="panel-demo-notice" role="status">演示数据，尚未接入真实 API。</div>
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
        <div className="panel-section-title">场景</div>
        <div className="panel-badge on">TRPG 战役</div>
      </div>

      <div className="panel-section">
        <div className="panel-section-title">激活源</div>
        <div className="panel-item"><span className="panel-dot ok"/> TRPG 战役 <span className="panel-meta">4 entries</span></div>
        <div className="panel-item"><span className="panel-dot ok"/> 默认 <span className="panel-meta">2 entries</span></div>
      </div>

      <div className="panel-section">
        <div className="panel-section-title">Block 序列</div>
        <div className="panel-block-list">
          <div className="panel-block-item"><span className="block-idx">1</span> gate <span className="block-label">角色卡</span></div>
          <div className="panel-block-item"><span className="block-idx">2</span> file <span className="block-label">场景设定</span></div>
          <div className="panel-block-item"><span className="block-idx">3</span> text <span className="block-label">NPC对话规则</span></div>
          <div className="panel-block-item dim"><span className="block-idx">4</span> external <span className="block-label">状态检查</span></div>
        </div>
      </div>

      <div className="panel-section">
        <div className="panel-section-title">当前注入</div>
        <div className="panel-stat">Tokens <strong>790</strong> / Gate 命中 <strong>3</strong></div>
        <div className="panel-stat mt">Prism <span className="panel-badge on">ON</span></div>
      </div>
    </div>
  )
}

function RagTab() {
  return (
    <div className="panel-tab">
      <div className="panel-empty">
        <div className="panel-empty-icon">📚</div>
        <div>RAG 知识库</div>
        <div className="panel-empty-hint">接入 ChromaDB / bge-m3 后</div>
        <div className="panel-empty-hint">在此检索知识库片段</div>
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
