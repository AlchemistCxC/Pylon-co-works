import { useStore } from '../store'

/**
 * SettingsPreview — 设置页右侧的实时 mock 预览
 *
 * 每个 zone（global/sidebar/chat/cc/right）渲染一个 mini 版本，
 * 直接读 store 里的 theme 字段，改设置即时反映。
 * 用纯 CSS + inline style 复刻各区域外观，不复用真实组件（避免副作用/invoke）。
 */

interface Props { zone: string }

export default function SettingsPreview({ zone }: Props) {
  const t = useStore() as any

  return (
    <div className="set-preview">
      <div className="set-preview-label">预览</div>
      <div className="set-preview-frame">
        {zone === 'global' && <GlobalPreview t={t} />}
        {zone === 'sidebar' && <SidebarPreview t={t} />}
        {zone === 'chat' && <ChatPreview t={t} />}
        {zone === 'cc' && <CCPreview t={t} />}
        {zone === 'right' && <RightPreview t={t} />}
        {!['global','sidebar','chat','cc','right'].includes(zone) && (
          <div className="set-preview-none">此页无预览</div>
        )}
      </div>
    </div>
  )
}

// ── 全局：模拟整窗（标题栏 + 玻璃背景 + 字体） ──
function GlobalPreview({ t }: { t: any }) {
  const font = t.globalFont === 'mono' ? 'var(--mono)' : 'var(--font)'
  return (
    <div className="pv-window" style={{
      fontFamily: font,
      fontSize: Math.max(10, (t.globalFontSize || 16) * 0.7),
      backgroundImage: t.globalBgImage ? `url(${t.globalBgImage})` : undefined,
      backgroundSize: 'cover',
    }}>
      <div className="pv-glass" style={{
        background: `rgba(240,240,245,${1 - (t.transparency ?? 0.85)})`,
        backdropFilter: `blur(${t.bgBlur || 0}px)`,
      }} />
      <div className="pv-titlebar">
        <span style={{ color: t.userColor || 'var(--text-dim)' }}>{t.userPrefix || '❯'}</span>
        <span> {t.userName || 'user'}</span>
      </div>
      <div className="pv-content">
        <div>字体预览 Aa 你好 123</div>
        <div style={{ opacity: 0.6, marginTop: 4 }}>The quick brown fox</div>
      </div>
    </div>
  )
}

// ── 左栏：会话列表 mock ──
function SidebarPreview({ t }: { t: any }) {
  return (
    <div className="pv-sidebar" style={{
      background: t.sidebarBg || 'transparent',
      backgroundImage: t.sidebarBgImage ? `url(${t.sidebarBgImage})` : undefined,
      backgroundSize: 'cover',
      color: t.sidebarTextColor || 'inherit',
      width: Math.min(180, (t.sidebarWidth || 250) * 0.7),
    }}>
      <div className="pv-sb-group" style={{ fontSize: t.sidebarGroupSize || 12 }}>本地</div>
      {['会话 A', '会话 B', '会话 C'].map((n, i) => (
        <div key={n} className={`pv-sb-item ${i === 0 ? 'active' : ''}`} style={{ fontSize: t.sidebarNameSize || 14 }}>
          <span className="pv-sb-dot" /> {n}
        </div>
      ))}
    </div>
  )
}

// ── 聊天区：user + assistant + tool call ──
function ChatPreview({ t }: { t: any }) {
  const font = t.chatFont === 'mono' ? 'var(--mono)' : 'var(--font)'
  return (
    <div className="pv-chat" style={{
      background: t.chatBg || 'transparent',
      backgroundImage: t.chatBgImage ? `url(${t.chatBgImage})` : undefined,
      backgroundSize: 'cover',
      fontFamily: font,
      fontSize: (t.chatFontSize || 15) * 0.85,
      lineHeight: t.chatLineHeight || 1.5,
      color: t.chatTextColor || 'inherit',
    }}>
      <div className="pv-user">
        <span style={{ color: t.userColor || t.userTagText }}>{t.userPrefix || '❯'} {t.userName || 'user'}</span>
        <span> 帮我改下这个函数</span>
      </div>
      <div className="pv-assistant">
        好的，我来看下。<code style={{ color: t.chatCodeColor, background: t.chatCodeBg, padding: '0 3px', borderRadius: 3 }}>foo()</code> 需要改。
      </div>
      <div className="pv-tool">
        <span style={{ color: t.toolOk || '#4ade80' }}>●</span>
        <span style={{ color: t.toolNameColor }}> Read</span>
        <span style={{ color: t.toolSummaryColor }}> (src/foo.ts)</span>
      </div>
      <div className="pv-tool">
        <span style={{ color: t.toolRun || '#60a5fa' }}>●</span>
        <span style={{ color: t.toolNameColor }}> Edit</span>
        <span style={{ color: t.toolSummaryColor }}> — 3 lines changed</span>
      </div>
    </div>
  )
}

// ── 中控区：输入栏 + 状态栏 mock ──
function CCPreview({ t }: { t: any }) {
  const isCli = t.inputMode === 'cli'
  return (
    <div className="pv-cc" style={{ background: t.ccBg && t.ccBg !== 'transparent' ? t.ccBg : 'rgba(0,0,0,0.03)' }}>
      <div className="pv-cc-input" style={{
        background: isCli ? 'transparent' : (t.inputBg || 'rgba(0,0,0,0.03)'),
        color: t.inputTextColor,
        borderLeft: isCli ? `${t.cliLineWidth || 2}px solid ${t.cliLineColor || 'var(--accent)'}` : undefined,
        border: isCli ? undefined : '1px solid var(--border)',
        fontFamily: 'var(--mono)',
      }}>
        {isCli && <span style={{ color: t.cliLineColor || 'var(--accent)', marginRight: 4 }}>❯</span>}
        <span style={{ color: t.inputPlaceholder }}>输入消息…</span>
      </div>
      <div className="pv-cc-status">
        <span style={{ color: t.ekgGreen || '#4ade80', fontFamily: 'var(--mono)', fontSize: 11 }}>▁▂▃▅▇ 42%</span>
        <span style={{ color: t.pillText, fontFamily: 'var(--mono)', fontSize: 10 }}>· deepseek-v4-flash</span>
        <span style={{ color: '#FFC107', fontFamily: 'var(--mono)', fontSize: 10 }}>· auto</span>
      </div>
    </div>
  )
}

// ── 右栏：面板 mock ──
function RightPreview({ t }: { t: any }) {
  return (
    <div className="pv-right" style={{
      background: t.rightBg || 'transparent',
      backgroundImage: t.rightBgImage ? `url(${t.rightBgImage})` : undefined,
      backgroundSize: 'cover',
      width: Math.min(180, (t.rightWidth || 260) * 0.7),
    }}>
      <div className="pv-right-tabs">
        <span className="active">Files</span><span>Prism</span><span>Logs</span>
      </div>
      <div className="pv-right-body">
        <div>▾ src/</div>
        <div style={{ paddingLeft: 12, opacity: 0.7 }}>main.rs</div>
        <div style={{ paddingLeft: 12, opacity: 0.7 }}>lib.rs</div>
      </div>
    </div>
  )
}
