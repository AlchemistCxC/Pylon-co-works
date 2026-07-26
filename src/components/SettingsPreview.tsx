import { useStore } from '../store'

/**
 * SettingsPreview — 设置页右侧实时预览
 *
 * 使用 CSS transform: scale() 缩放真实布局的 mock —
 * 渲染一个全宽容器（700px），通过 scale 压入 440px 预览栏，
 * 视觉效果远比固定尺寸 mock 更接近真实。
 */

interface Props { zone: string }

const SCALE_W = 700   // 模拟宽度（模拟屏幕截面）
const SCALE_H = 460   // 模拟高度

export default function SettingsPreview({ zone }: Props) {
  const t = useStore() as any
  const bgColor = t.globalBgColor || '#e8e8ec'
  const scheme = t.uiScheme || 'light'
  const isDark = scheme === 'dark'

  const uiTokens = isDark ? {
    bg: 'rgba(255,255,255,0.04)',
    bgHover: 'rgba(255,255,255,0.08)',
    border: 'rgba(255,255,255,0.12)',
    text: 'rgba(255,255,255,0.9)',
    textDim: 'rgba(255,255,255,0.45)',
  } : {
    bg: 'rgba(0,0,0,0.03)',
    bgHover: 'rgba(0,0,0,0.06)',
    border: 'rgba(0,0,0,0.10)',
    text: 'rgba(0,0,0,0.85)',
    textDim: 'rgba(0,0,0,0.40)',
  }

  return (
    <div className="set-preview-wrap">
      <ScaledPreview width={SCALE_W} height={SCALE_H}>
        <AppMock t={t} bgColor={bgColor} ui={uiTokens} zone={zone} />
      </ScaledPreview>
    </div>
  )
}

// ── Scale wrapper ──────────────────────────────────────────────
function ScaledPreview({ width, height, children }: { width:number; height:number; children:React.ReactNode }) {
  // 容器由 CSS 控制宽度（在父元素里撑满），scale 动态适配
  return (
    <div className="set-preview-scaler-outer" style={{ height: 0, paddingBottom: `${(height / width) * 100}%`, position: 'relative', overflow: 'hidden', borderRadius: 8, border: '1px solid var(--border)' }}>
      <div style={{
        position: 'absolute', inset: 0,
        overflow: 'hidden',
        borderRadius: 8,
      }}>
        <div className="set-preview-scaler-inner" style={{
          width, height,
          transformOrigin: 'top left',
          // scale 通过 CSS container query 不可用，用 inline var
          transform: `scale(var(--preview-scale, 0.6))`,
        }}>
          {children}
        </div>
      </div>
    </div>
  )
}

// ── 完整应用 mock ──────────────────────────────────────────────
function AppMock({ t, bgColor, ui, zone }: { t:any; bgColor:string; ui:any; zone:string }) {
  const font = t.globalFont === 'mono' ? "'Cascadia Code','Consolas',monospace" : "system-ui,sans-serif"
  const chatFont = t.chatFont === 'mono' ? "'Cascadia Code','Consolas',monospace" : "system-ui,sans-serif"
  const sidebarW = t.sidebarWidth || 250

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      background: bgColor,
      fontFamily: font,
      fontSize: t.globalFontSize || 16,
      color: ui.text,
      overflow: 'hidden',
    }}>
      {/* Titlebar */}
      <div style={{
        height: 30, display: 'flex', alignItems: 'center',
        padding: '0 10px', gap: 6, flexShrink: 0,
        background: 'rgba(0,0,0,0.03)',
        borderBottom: `1px solid ${ui.border}`,
      }}>
        <span style={{ fontSize: 12, opacity: 0.5 }}>☰</span>
        <span style={{ fontSize: 12, padding: '2px 10px', background: ui.bg, borderRadius: 4 }}>Peri</span>
        <span style={{ fontSize: 12, opacity: 0.4 }}>Prism</span>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Sidebar */}
        <div style={{
          width: sidebarW, flexShrink: 0,
          background: t.sidebarBg || ui.bg,
          borderRight: `1px solid ${ui.border}`,
          display: 'flex', flexDirection: 'column',
          padding: '8px 0',
          color: t.sidebarTextColor || ui.text,
          fontFamily: chatFont,
        }}>
          <div style={{ padding: '4px 12px 8px', fontSize: 10, opacity: 0.5, textTransform: 'uppercase', letterSpacing: '0.5px' }}>本地</div>
          {['会话 A', '会话 B'].map((n, i) => (
            <div key={n} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px',
              background: i === 0 ? ui.bgHover : 'transparent',
              fontSize: t.sidebarNameSize || 14,
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: i === 0 ? '#4ade80' : ui.textDim, flexShrink: 0, display: 'inline-block' }} />
              {n}
            </div>
          ))}
        </div>

        {/* Main */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          {/* Chat area — highlight if zone=chat */}
          <div style={{
            flex: 1, overflowY: 'hidden',
            padding: '12px 20px',
            background: t.chatBg || 'transparent',
            fontFamily: chatFont,
            fontSize: t.chatFontSize || 15,
            lineHeight: t.chatLineHeight || 1.5,
            color: t.chatTextColor || ui.text,
            outline: zone === 'chat' ? `2px solid var(--accent,#3b82f6)` : undefined,
            outlineOffset: zone === 'chat' ? '-2px' : undefined,
          }}>
            {/* User line */}
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: t.userColor || '#a855f7', fontWeight: 700 }}>{t.userPrefix || '❯'} </span>
              <span style={{ color: t.userColor || '#a855f7', fontWeight: 700 }}>user </span>
              <span>帮我看一下这段代码</span>
            </div>

            {/* Tool calls */}
            {[
              { name: 'Read', input: 'src/main.ts', done: true },
              { name: 'Bash', input: 'npm run build', done: false },
            ].map((tool, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: t.chatFontSize ? t.chatFontSize - 1 : 14, fontFamily: "'Cascadia Code',monospace" }}>
                <span style={{ color: tool.done ? (t.toolOk || '#4ade80') : (t.toolRun || '#60a5fa') }}>●</span>
                <span style={{ color: t.toolNameColor || ui.text, fontWeight: 700 }}>{tool.name}</span>
                <span style={{ color: t.toolSummaryColor || ui.textDim }}> ({tool.input})</span>
              </div>
            ))}

            {/* Assistant response */}
            <div style={{ marginTop: 8 }}>
              好的，我来分析这段代码。<code style={{ color: t.chatCodeColor || '#b47814', background: t.chatCodeBg || 'rgba(0,0,0,0.04)', padding: '1px 4px', borderRadius: 3, fontFamily: 'inherit' }}>main()</code> 函数有一处问题。
            </div>
          </div>

          {/* Control center */}
          <div style={{
            height: t.ccHeight || 110, flexShrink: 0,
            background: t.ccBg && t.ccBg !== 'transparent' ? t.ccBg : 'rgba(0,0,0,0.02)',
            borderTop: `1px solid ${ui.border}`,
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
            padding: '6px 12px',
            outline: zone === 'cc' ? `2px solid var(--accent,#3b82f6)` : undefined,
            outlineOffset: zone === 'cc' ? '-2px' : undefined,
          }}>
            {/* Input */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              borderLeft: t.inputMode === 'cli' ? `${t.cliLineWidth || 2}px solid ${t.cliLineColor || '#D77757'}` : undefined,
              border: t.inputMode !== 'cli' ? `1px solid ${ui.border}` : undefined,
              background: t.inputMode !== 'cli' ? (t.inputBg || 'transparent') : 'transparent',
              borderRadius: t.inputMode !== 'cli' ? 6 : undefined,
              padding: t.inputMode === 'cli' ? '4px 0 4px 8px' : '6px 10px',
              marginBottom: 6,
            }}>
              {t.inputMode === 'cli' && <span style={{ color: t.cliTextColor || ui.textDim, fontFamily: 'monospace' }}>❯</span>}
              <span style={{ color: t.inputPlaceholder || ui.textDim, fontSize: t.inputFontSize || 15, fontFamily: 'monospace' }}>输入消息...</span>
            </div>
            {/* Status */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: 'monospace' }}>
              <span style={{ color: t.ekgGreen || '#4ade80' }}>
                ▂▃▅▆▇▆▅▃▂ 0%
              </span>
              <span style={{ color: t.pillText || ui.textDim }}>{t.modelVariant === 'minimal' ? 'deepseek-v4-flash' : '▾ deepseek-v4-flash'}</span>
              <span style={{ color: '#FFC107' }}>auto</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
