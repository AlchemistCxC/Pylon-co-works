import { useStore } from '../store'

/**
 * SettingsPreview — 设置页右侧实时预览
 *
 * 渲染 900px 宽的完整应用 mock，通过 CSS scale 压入预览栏（约 508px）
 * scale = 508 / 900 ≈ 0.564
 *
 * 高亮当前编辑 zone（outline），与左侧设置项对应。
 */

interface Props { zone: string }

const MOCK_W = 900
const MOCK_H = 540

export default function SettingsPreview({ zone }: Props) {
  const t = useStore() as any
  const isDark = (t.uiScheme || 'light') === 'dark'
  const bgColor = t.globalBgColor || '#e8e8ec'

  const ui = isDark ? {
    bg: 'rgba(255,255,255,0.05)', bgHover: 'rgba(255,255,255,0.10)',
    border: 'rgba(255,255,255,0.13)', text: 'rgba(255,255,255,0.90)',
    textDim: 'rgba(255,255,255,0.45)', input: 'rgba(255,255,255,0.07)',
  } : {
    bg: 'rgba(0,0,0,0.03)', bgHover: 'rgba(0,0,0,0.06)',
    border: 'rgba(0,0,0,0.10)', text: 'rgba(0,0,0,0.85)',
    textDim: 'rgba(0,0,0,0.40)', input: 'rgba(0,0,0,0.03)',
  }

  return (
    <div className="set-preview-wrap">
      {/* padding-bottom trick: aspect ratio box */}
      <div style={{ height: 0, paddingBottom: `${(MOCK_H / MOCK_W) * 100}%`, position: 'relative', borderRadius: 10, overflow: 'hidden', border: `1px solid ${ui.border}`, boxShadow: '0 4px 20px rgba(0,0,0,0.12)' }}>
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 10 }}>
          <div style={{
            width: MOCK_W, height: MOCK_H,
            transformOrigin: 'top left',
            transform: `scale(var(--preview-scale, 0.56))`,
          }}>
            <AppMock t={t} bgColor={bgColor} ui={ui} zone={zone} />
          </div>
        </div>
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)', opacity: 0.7, textAlign: 'center', fontFamily: 'var(--mono)' }}>
        {zone} · 实时预览
      </div>
    </div>
  )
}

// ── 完整应用 mock ──────────────────────────────────────────────
function AppMock({ t, bgColor, ui, zone }: { t:any; bgColor:string; ui:any; zone:string }) {
  const font = t.globalFont === 'mono' ? "'Cascadia Code','JetBrains Mono','Consolas',monospace" : "system-ui,-apple-system,sans-serif"
  const chatFont = t.chatFont === 'mono' ? "'Cascadia Code','JetBrains Mono','Consolas',monospace" : "system-ui,sans-serif"
  const sw = Math.min(t.sidebarWidth || 250, 280)
  const ccH = t.ccHeight || 110
  const isCli = t.inputMode === 'cli'
  const cliColor = t.cliLineColor || '#D77757'
  const cliPad = t.cliLinePadding ?? 6
  const cliW = t.cliLineWidth || 2
  const connMode = t.toolConnectorMode || 'none'

  // 3 连续 tool calls 模拟连接线
  const tools = [
    { name: 'Read', input: 'src/main.ts', done: true, color: t.toolOk || '#4ade80' },
    { name: 'Bash', input: 'npm run build', done: true, color: t.toolOk || '#4ade80' },
    { name: 'Edit', input: 'src/main.ts', done: false, color: t.toolRun || '#60a5fa' },
  ]

  const indicator = t.toolIndicator || '●'
  const glow = t.toolIndicatorGlow || 0

  return (
    <div style={{ width: MOCK_W, height: MOCK_H, display: 'flex', flexDirection: 'column', background: bgColor, fontFamily: font, fontSize: t.globalFontSize || 16, color: ui.text, overflow: 'hidden' }}>
      {/* Titlebar */}
      <div style={{ height: 32, display: 'flex', alignItems: 'center', padding: '0 12px', gap: 8, flexShrink: 0, borderBottom: `1px solid ${ui.border}`, background: 'rgba(0,0,0,0.02)', outline: zone === 'global' ? '2px solid var(--accent,#3b82f6)' : undefined, outlineOffset: '-1px' }}>
        <span style={{ opacity: 0.5, fontSize: 13 }}>☰</span>
        <span style={{ fontSize: 12, padding: '2px 12px', background: ui.bg, borderRadius: 4 }}>Peri</span>
        <span style={{ fontSize: 12, opacity: 0.4 }}>Prism</span>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Sidebar */}
        <div style={{
          width: sw, flexShrink: 0, display: 'flex', flexDirection: 'column',
          background: t.sidebarBg || ui.bg,
          borderRight: `1px solid ${ui.border}`,
          color: t.sidebarTextColor || ui.text,
          fontFamily: chatFont,
          padding: '6px 0',
          outline: zone === 'sidebar' ? '2px solid var(--accent,#3b82f6)' : undefined,
          outlineOffset: '-1px',
        }}>
          <div style={{ padding: '4px 12px 6px', fontSize: 10, opacity: 0.45, textTransform: 'uppercase', letterSpacing: '0.6px', fontFamily: chatFont }}>本地</div>
          {['会话 A', '会话 B', '会话 C'].map((n, i) => (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: `${(t.sidebarNameSize || 14) * 0.35}px 12px`, background: i === 0 ? ui.bgHover : 'transparent', fontSize: t.sidebarNameSize || 14 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: i === 0 ? (t.toolOk || '#4ade80') : ui.textDim, flexShrink: 0, display: 'inline-block', boxShadow: i === 0 ? `0 0 4px ${t.toolOk || '#4ade80'}` : undefined }} />
              {n}
            </div>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderTop: `1px solid ${ui.border}` }}>
            {['R', 'S'].map(l => (
              <div key={l} style={{ width: 28, height: 28, borderRadius: 6, background: ui.bg, border: `1px solid ${ui.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600 }}>{l}</div>
            ))}
          </div>
        </div>

        {/* Main */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

          {/* Chat */}
          <div style={{
            flex: 1, overflow: 'hidden',
            padding: '14px 22px 6px',
            background: t.chatBg && t.chatBg !== '' ? t.chatBg : 'transparent',
            fontFamily: chatFont, fontSize: t.chatFontSize || 15,
            lineHeight: t.chatLineHeight || 1.5,
            color: t.chatTextColor || ui.text,
            outline: zone === 'chat' ? '2px solid var(--accent,#3b82f6)' : undefined,
            outlineOffset: zone === 'chat' ? '-2px' : undefined,
          }}>
            {/* User line */}
            <div style={{ marginBottom: 10, display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ color: t.userColor || t.userTagText || '#a855f7', fontWeight: 700, fontFamily: chatFont }}>{t.userPrefix || '❯'}</span>
              <span style={{ color: t.userColor || '#a855f7', fontWeight: 700 }}>{t.userName || 'user'}</span>
              <span>帮我检查一下这段代码</span>
            </div>

            {/* Tool calls 连续调用，带竖线 */}
            <div style={{ marginBottom: 8 }}>
              {tools.map((tool, i) => {
                const connColor = connMode === 'none' ? 'transparent'
                  : connMode === 'follow' ? tool.color
                  : (t.toolConnectorColor || 'rgba(128,128,128,0.3)')
                const glowStyle = glow > 0
                  ? { textShadow: `0 0 ${glow}px ${tool.color}` }
                  : undefined
                return (
                  <div key={i} style={{ position: 'relative', padding: `2px 0`, display: 'flex', alignItems: 'center', gap: 6, fontFamily: chatFont, fontSize: (t.chatFontSize || 15) - 1 }}>
                    {/* 竖线连接 */}
                    {i > 0 && connMode !== 'none' && (
                      <div style={{ position: 'absolute', left: 5, top: -8, width: 2, height: 12, background: connColor, borderRadius: 1 }} />
                    )}
                    <span style={{ color: tool.color, ...glowStyle, flexShrink: 0 }}>{indicator}</span>
                    <span style={{ color: t.toolNameColor || ui.text, fontWeight: 700 }}>{tool.name}</span>
                    <span style={{ color: t.toolSummaryColor || ui.textDim }}>({tool.input})</span>
                    {tool.done && <span style={{ color: t.toolSummaryColor || ui.textDim, fontSize: (t.chatFontSize || 15) - 2 }}>— 12 lines</span>}
                  </div>
                )
              })}
            </div>

            {/* Assistant response */}
            <div style={{ color: t.chatTextColor || ui.text }}>
              好的，我来分析一下。
              <code style={{ color: t.chatCodeColor || '#b47814', background: t.chatCodeBg || 'rgba(0,0,0,0.04)', padding: '0 4px', borderRadius: 3, fontFamily: chatFont }}>main()</code>
              {' '}里有一处类型错误需要修正：
            </div>
            <div style={{ margin: '6px 0', background: t.chatCodeBg || 'rgba(0,0,0,0.04)', border: `1px solid ${ui.border}`, borderRadius: 4, padding: '6px 10px', fontFamily: chatFont, fontSize: (t.chatFontSize || 15) - 1, color: t.chatTextColor || ui.text }}>
              <span style={{ color: t.chatCodeColor || '#b47814' }}>const</span> <span>result = await fetch(url)</span>
            </div>
          </div>

          {/* Control center */}
          <div style={{
            height: ccH, flexShrink: 0,
            background: t.ccBg && t.ccBg !== 'transparent' ? t.ccBg : ui.input,
            borderTop: `1px solid ${ui.border}`,
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
            padding: '8px 14px',
            position: 'relative',
            outline: zone === 'cc' ? '2px solid var(--accent,#3b82f6)' : undefined,
            outlineOffset: zone === 'cc' ? '-2px' : undefined,
          }}>
            {/* Input — CLI or default */}
            {isCli ? (
              <div style={{
                borderTop: `${cliW}px solid ${cliColor}`,
                borderBottom: `${cliW}px solid ${cliColor}`,
                padding: `${cliPad}px 0`,
                display: 'flex', alignItems: 'center', gap: 6,
                marginBottom: 6,
              }}>
                <span style={{ color: t.cliTextColor || ui.textDim, fontFamily: chatFont, fontSize: t.inputFontSize || 15 }}>❯</span>
                <span style={{ color: t.inputPlaceholder || ui.textDim, fontFamily: chatFont, fontSize: t.inputFontSize || 15 }}>输入消息...</span>
              </div>
            ) : (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                border: `1px solid ${ui.border}`,
                background: t.inputBg || ui.input,
                borderRadius: 8, padding: '8px 12px', marginBottom: 6,
                minHeight: Math.min(t.inputMinHeight || 52, 52),
              }}>
                <span style={{ color: t.inputPlaceholder || ui.textDim, fontFamily: chatFont, fontSize: t.inputFontSize || 15, flex: 1 }}>输入消息...</span>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: t.inputSendBg || ui.bg, border: `1px solid ${ui.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: ui.textDim }}>↑</div>
              </div>
            )}
            {/* Status bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, fontFamily: chatFont }}>
              {/* EKG mini */}
              <svg width="80" height="18" viewBox="0 0 80 18" style={{ flexShrink: 0 }}>
                <line x1="0" y1="9" x2="80" y2="9" stroke={t.ekgGreen || '#4ade80'} strokeWidth="1.5" opacity="0.4"/>
                <polyline points="0,9 10,9 14,4 18,14 22,9 26,9 30,9 36,4 40,9 44,9 80,9" fill="none" stroke={t.ekgGreen || '#4ade80'} strokeWidth="1.5" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 2px ${t.ekgGreen || '#4ade80'})` }}/>
                <line x1="1" y1="4" x2="1" y2="14" stroke={t.ekgGreen || '#4ade80'} strokeWidth="1.5"/>
                <line x1="4" y1="4" x2="4" y2="14" stroke={t.ekgGreen || '#4ade80'} strokeWidth="1.5"/>
                <line x1="80" y1="4" x2="80" y2="14" stroke={t.ekgGreen || '#4ade80'} strokeWidth="2"/>
              </svg>
              <span style={{ color: t.ekgGreen || '#4ade80' }}>0%</span>
              <span style={{ color: t.pillText || ui.textDim }}> · 0/131K</span>
              <span style={{ color: t.pillText || ui.textDim }}> · deepseek-v4-flash</span>
              <span style={{ color: '#FFC107' }}> · auto</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
