import { useMemo } from 'react'
import './StatusBar.css'

function wave(w: number, h: number, intensity: number): string {
  const mid = h / 2, amp = 3 + intensity * 8
  const pts = [`0,${mid}`], N = 50
  for (let i = 1; i <= N; i++) {
    const x = (i / N) * w, p = i % 16
    let y = mid
    if (p < 2) y = mid
    else if (p < 4) y = mid + Math.sin((p-2)/2*Math.PI) * amp * 0.5
    else if (p < 6) y = mid
    else if (p < 7) y = mid - amp * 1.3
    else if (p < 8) y = mid + Math.sin((p-7)*Math.PI) * amp * 1.6
    else if (p < 9) y = mid + amp * 0.6
    else if (p < 11) y = mid
    else if (p < 14) y = mid + Math.sin((p-11)/3*Math.PI) * amp * 0.35
    else y = mid
    pts.push(`${x.toFixed(1)},${y.toFixed(2)}`)
  }
  return pts.join(' ')
}

const MODES = ['default', 'edit', 'auto', 'bypass'] as const
type Mode = typeof MODES[number]

const MODE_NAMES: Record<Mode, string> = {
  default: 'default', edit: 'edit', auto: 'auto', bypass: 'bypass',
}

export default function StatusBar({
  tokensUsed = 18, tokensMax = 128, msgCount = 47, cacheHit = 93,
  mode = 'auto', onCompact, onMode,
}: {
  tokensUsed?: number; tokensMax?: number; msgCount?: number
  cacheHit?: number; mode?: string; onCompact?: () => void
  onMode?: (m: string) => void
}) {
  const used = tokensMax > 0 ? tokensUsed / tokensMax : 0
  const pct = Math.round(used * 100)

  // color: green < 50% used, yellow 50-75%, red > 75%
  const color = used < 0.50 ? '#1e9646' : used < 0.75 ? '#b47814' : '#be2828'
  const intensity = Math.min(1, used * 1.5)

  const W = 240, H = 34, mid = H / 2
  const cut = W * used
  const epH = 6
  const wf = useMemo(() => wave(W * (1 + intensity), H, intensity), [intensity])

  const cycleMode = () => {
    const idx = MODES.indexOf(mode as Mode)
    onMode?.(MODES[(idx + 1) % MODES.length])
  }

  return (
    <div className="status-bar" onClick={onCompact}>
      <svg viewBox={`0 0 ${W} ${H}`} className="ekg-svg" preserveAspectRatio="none">
        {/* 定端点 */}
        <line x1="0" y1={mid-epH} x2="0" y2={mid+epH} stroke="rgba(0,0,0,0.3)" strokeWidth="1.2"/>
        <line x1={W} y1={mid-epH} x2={W} y2={mid+epH} stroke="rgba(0,0,0,0.3)" strokeWidth="1.2"/>

        {/* 基线：已用区彩色，剩余区灰色 */}
        <line x1="0" y1={mid} x2={cut} y2={mid} stroke={color} strokeWidth="1.5" strokeOpacity="0.6"/>
        <line x1={cut} y1={mid} x2={W} y2={mid} stroke="rgba(0,0,0,0.08)" strokeWidth="1.5"/>

        {/* 动端点 */}
        <line x1={cut} y1={mid-epH} x2={cut} y2={mid+epH} stroke={color} strokeWidth="1.8"/>

        {/* 已用区——彩色波形 */}
        <clipPath id="active"><rect x="0" y="0" width={cut} height={H}/></clipPath>
        <polyline points={wf} fill="none" stroke={color} strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round" clipPath="url(#active)"
          style={{ filter: `drop-shadow(0 0 3px ${color}80)` } as any}/>

        {/* 剩余区——灰色静默线（无波形） */}
      </svg>

      <span className="ekg-pct" style={{ color }}>{pct}%</span>
      <span className="pill-mono">{tokensUsed}K/{tokensMax}K</span>
      <span className="pill-mono" style={{ color: '#1e9646' }}>{cacheHit}% hit</span>
      <span className="pill-plain">{msgCount} msg</span>

      <div className="mode-switch" onClick={e => { e.stopPropagation(); cycleMode() }}>
        <span className="mode-label">{MODE_NAMES[mode as Mode] || mode}</span>
        <span className="mode-cycle">&#8635;</span>
      </div>
    </div>
  )
}
