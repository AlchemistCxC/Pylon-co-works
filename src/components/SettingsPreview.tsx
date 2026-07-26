import ControlCenter from './ControlCenter'

/**
 * SettingsPreview — 设置页右侧实时预览（去 Mock 化）
 *
 * 复用真实 CSS 类（.titlebar/.sidebar/.term）+ 直接渲染真实 ControlCenter 组件。
 * CSS 变量从外层 .app 天然继承 → 改任意设置立即在预览中真实生效。
 * ControlCenter 里的 EKG 会实时动画、所有 widget 真实呈现。
 *
 * pointer-events:none：预览只读，点击不会误触发交互 / 污染 store。
 */

interface Props { zone: string }

const MOCK_W = 1200
const MOCK_H = 720

export default function SettingsPreview({ zone }: Props) {
  return (
    <div className="set-preview-wrap">
      <div className="set-preview-frame" style={{ height: 0, paddingBottom: `${(MOCK_H / MOCK_W) * 100}%` }}>
        <div className="set-preview-clip">
          <div className="set-preview-scaled" style={{ width: MOCK_W, height: MOCK_H }}>
            <PreviewApp zone={zone} />
          </div>
        </div>
      </div>
      <div className="set-preview-caption">{zone} · 实时预览（真实渲染）</div>
    </div>
  )
}

// ── 预览应用：真实 CSS 类骨架 + 真实 ControlCenter ──────────────
function PreviewApp({ zone }: { zone: string }) {
  const z = (name: string): React.CSSProperties =>
    zone === name ? { outline: '2px solid var(--accent,#3b82f6)', outlineOffset: '-2px' } : {}

  return (
    <div className="pv-app" style={{ pointerEvents: 'none' }}>
      {/* Titlebar — 真实类 */}
      <div className="titlebar" style={{ ...z('global'), WebkitAppRegion: 'no-drag' } as any}>
        <span className="titlebar-toggle">☰</span>
        <div className="titlebar-tabs">
          <button className="tab active">Peri</button>
          <button className="tab">Prism</button>
        </div>
      </div>

      <div className="layout" style={{ flex: 1, minHeight: 0 }}>
        {/* Sidebar — 真实类 */}
        <aside className="sidebar" style={z('sidebar')}>
          <div className="sidebar-header">
            <input className="search-input" placeholder="搜索会话..." readOnly />
            <span className="sidebar-action">+</span>
          </div>
          <div className="session-list">
            <div className="group-header" style={{ display: 'block' }}>本地</div>
            {['会话 A', '会话 B', '会话 C'].map((n, i) => (
              <div key={n} className={`session-item ${i === 0 ? 'active' : ''}`}>
                <span className="session-dot" />
                <div className="session-info">
                  <div className="session-name">{n}</div>
                  <div className="session-meta">刚刚</div>
                </div>
              </div>
            ))}
          </div>
          <div className="profile-bar">
            <span className="profile-avatar active">R</span>
            <span className="profile-avatar">S</span>
          </div>
        </aside>

        {/* Main */}
        <div className="main" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div className="main-body" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {/* Chat — 真实 .term 类 */}
            <div className="chat-view" style={z('chat')}>
              <div className="term">
                <div className="term-user">
                  <span className="term-user-prefix">❯</span>
                  <span className="term-user-name">user</span>
                  <span>帮我检查一下这段代码</span>
                </div>
                {[
                  { name: 'Read', input: 'src/main.ts', done: true },
                  { name: 'Bash', input: 'npm run build', done: true },
                  { name: 'Edit', input: 'src/main.ts', done: false },
                ].map((tl, i) => (
                  <div key={i} className={`term-row term-row-tool`}>
                    <PvTool {...tl} />
                  </div>
                ))}
                <div className="term-assistant">
                  好的，我来分析一下。<code className="term-inline-code">main()</code> 里有一处类型错误需要修正。
                  <div className="term-code"><pre><code>const result = await fetch(url)</code></pre></div>
                </div>
              </div>
            </div>

            {/* Control center — 真实组件！ */}
            <div style={z('cc')}>
              <ControlCenter sessionId={null} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// 复用真实 ToolCard 的类，让竖线连接 / 辉光 / 颜色全部由真实 CSS 驱动
function PvTool({ name, input, done }: { name: string; input: string; done: boolean }) {
  return (
    <div className="term-tool" data-status={done ? 'ok' : 'run'}>
      <div className="term-tool-head">
        <span className={`term-tool-indicator ${done ? 'ok' : 'run'}`}>●</span>
        <span className="term-tool-name">{name}</span>
        <span className="term-tool-summary"> ({input})</span>
        {done && <span className="term-tool-suffix"> — 12 lines</span>}
      </div>
    </div>
  )
}
