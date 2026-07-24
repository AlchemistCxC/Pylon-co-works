import { useMemo, useState, useEffect } from 'react'
import './StatusBar.css'

// 真实 ECG P-Q-R-S-T 波形
function wave(w: number, h: number, intensity: number, offset: number): string {
  const mid = h / 2
  const amp = 3 + intensity * 8
  const pts = [`0,${mid}`]
  const cycleW = 70 + (1 - intensity) * 40
  const cycles = Math.max(2, Math.ceil(w / cycleW * 2)) * 2

  const phases = [
    { start:0.00, end:0.08, type:'p' }, { start:0.08, end:0.20, type:'flat' },
    { start:0.20, end:0.23, type:'q' }, { start:0.23, end:0.26, type:'r' },
    { start:0.26, end:0.30, type:'s' }, { start:0.30, end:0.45, type:'flat' },
    { start:0.45, end:0.65, type:'t' }, { start:0.65, end:1.00, type:'flat' },
  ]

  for (let ci = -2; ci < cycles; ci++) {
    for (const ph of phases) {
      const steps = Math.max(2, Math.floor((ph.end - ph.start) * cycleW / 3))
      for (let s = 0; s <= steps; s++) {
        const t = s / Math.max(1, steps)
        const phaseT = ph.start + t * (ph.end - ph.start)
        const x = (ci + phaseT) / (cycles * 0.7) * w * 1.5 + offset
        let y = mid
        switch (ph.type) {
          case 'p': y = mid - Math.sin(t * Math.PI) * amp * 0.35; break
          case 'flat': y = mid; break
          case 'q': y = mid + t * amp * 0.5; break
          case 'r': y = mid + amp * 0.5 - Math.sin(t * Math.PI) * amp * 1.8; break
          case 's': y = mid + amp * 0.5 + Math.sin(t * Math.PI) * amp * 1.2; break
          case 't': y = mid - Math.sin(t * Math.PI) * amp * 0.6; break
        }
        pts.push(`${x.toFixed(1)},${y.toFixed(2)}`)
      }
    }
  }
  return pts.join(' ')
}

const MODES = ['default', 'edit', 'auto', 'bypass'] as const
type Mode = typeof MODES[number]

export default function StatusBar({
  tokensUsed = 18, tokensMax = 128, msgCount = 47, cacheHit = 93,
  mode = 'auto', prismOn = true, model = 'v4-flash',
  ekgGreen, ekgYellow, ekgRed,
  onCompact, onMode, onPrismToggle,
}: {
  tokensUsed?: number; tokensMax?: number; msgCount?: number
  cacheHit?: number; mode?: string; prismOn?: boolean
  model?: string; ekgGreen?: string; ekgYellow?: string; ekgRed?: string
  onCompact?: () => void; onMode?: (m: string) => void; onPrismToggle?: () => void
}) {
  const [, tick] = useState(0)

  // Pulse animation: continuously move offset left to right
  useEffect(() => {
    const id = setInterval(() => tick(p => p + 1), 30)
    return () => clearInterval(id)
  }, [])

  const used = Math.max(0, Math.min(1, tokensMax > 0 ? tokensUsed / tokensMax : 0))
  const pct = Math.round(used * 100)
  const color = used < 0.50 ? (ekgGreen||'#34d399') : used < 0.75 ? (ekgYellow||'#fbbf24') : (ekgRed||'#f87171')
  const intensity = Math.min(1, used * 1.5)

  const W = 240, H = 30, mid = H / 2
  const cut = Math.max(4, W * used)
  const offset = (tick * 0.5) % (W * 0.5)  // pulse offset

  const wf = useMemo(() => wave(W, H, intensity, offset), [intensity])
  const wfAnimated = useMemo(() => wave(W, H, intensity, offset), [intensity, tick])

  const cycleMode = () => {
    const idx = MODES.indexOf(mode as Mode)
    onMode?.(MODES[(idx + 1) % MODES.length])
  }

  return (
    <div className="status-bar" onClick={onCompact}>
      <svg viewBox={`0 0 ${W} ${H}`} className="ekg-svg" preserveAspectRatio="none">
        {/* 基线——加粗 2.5px */}
        <line x1="0" y1={mid} x2={W} y2={mid} stroke="rgba(0,0,0,0.06)" strokeWidth="2.5"/>

        {/* 定端点——加粗宽度+高度 */}
        <line x1="0" y1={mid-7} x2="0" y2={mid+7} stroke="rgba(0,0,0,0.35)" strokeWidth="2.5"/>
        <line x1={W} y1={mid-7} x2={W} y2={mid+7} stroke="rgba(0,0,0,0.35)" strokeWidth="2.5"/>

        {/* 已用区彩色基线 */}
        <line x1="0" y1={mid} x2={cut} y2={mid} stroke={color} strokeWidth="2.5" strokeOpacity="0.6"/>
        {/* 剩余区灰色基线 */}
        <line x1={cut} y1={mid} x2={W} y2={mid} stroke="rgba(0,0,0,0.06)" strokeWidth="2.5"/>

        {/* 动端点——加粗 */}
        <line x1={cut} y1={mid-7} x2={cut} y2={mid+7} stroke={color} strokeWidth="3"/>

        {/* 彩色波形——已用区，脉冲左→右传播 */}
        <clipPath id="active"><rect x="0" y="0" width={cut} height={H}/></clipPath>
        <polyline points={wfAnimated} fill="none" stroke={color} strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round" clipPath="url(#active)"
          className="ekg-pulse"
          style={{ filter: `drop-shadow(0 0 4px ${color}99)` } as any}/>
      </svg>

      <span className="ekg-pct" style={{ color }}>{pct}%</span>
      <span className="pill-mono">{tokensUsed}K/{tokensMax}K</span>
      <span className="pill-mono" style={{ color: '#34d399' }}>{cacheHit}% hit</span>

      <button className={`prism-tag ${prismOn ? 'on' : 'off'}`}
        onClick={e => { e.stopPropagation(); onPrismToggle?.() }}>
        Prism {prismOn ? 'ON' : 'OFF'}
      </button>

      <button className="model-tag" onClick={e => e.stopPropagation()}>
        {model} ▾
      </button>

      <div className="mode-switch" onClick={e => { e.stopPropagation(); cycleMode() }}>
        <span className="mode-label">{mode}</span>
        <span className="mode-cycle">↻</span>
      </div>
    </div>
  )
}
