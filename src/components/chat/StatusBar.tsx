import { useMemo, useState, useEffect } from 'react'
import { useStore } from '../../store'
import './StatusBar.css'

function hash(seed: number): number {
  return ((Math.sin(seed * 127.1) * 43758.5453) % 1 + 1) % 1
}

function wave(w: number, h: number, intensity: number, offset: number, ampMax: number, noiseScale: number): string {
  const mid = h / 2
  const amp = 3 + intensity * ampMax
  const baseCycleW = 70 + (1 - intensity) * 40
  const phases = [
    { start:0.00, end:0.08, type:'p' }, { start:0.08, end:0.20, type:'flat' },
    { start:0.20, end:0.23, type:'q' }, { start:0.23, end:0.26, type:'r' },
    { start:0.26, end:0.30, type:'s' }, { start:0.30, end:0.45, type:'flat' },
    { start:0.45, end:0.65, type:'t' }, { start:0.65, end:1.00, type:'flat' },
  ]

  const pts: string[] = []
  let cycleIndex = Math.floor((-w - offset) / baseCycleW)

  while (true) {
    const rri = Math.sin(cycleIndex * 0.7 + offset * 0.015) * 12
    const cycleW = baseCycleW + rri
    const xStart = cycleIndex * baseCycleW + offset

    if (xStart > w + baseCycleW * 2) break

    for (const ph of phases) {
      const steps = Math.max(2, Math.floor((ph.end - ph.start) * cycleW / 3))
      for (let s = 0; s <= steps; s++) {
        const t = s / Math.max(1, steps)
        const phT = ph.start + t * (ph.end - ph.start)
        const x = xStart + phT * cycleW
        if (x < -10 || x > w + 10) continue
        const jitter = (hash(Math.floor(x * 100)) - 0.5) * 2 * noiseScale * 0.02
        const xJittered = x + jitter
        if (xJittered < -10 || xJittered > w + 10) continue
        let y = mid
        switch (ph.type) {
          case 'p': y = mid - Math.pow(t, 2) * Math.pow(1 - t, 0.6) * amp * 0.8; break
          case 'flat': y = mid; break
          case 'q': y = mid + t * amp * 0.5; break
          case 'r':
            if (t < 0.5) y = mid + t * 2 * amp * 2.0
            else         y = mid + (1 - t) * 2 * amp * 1.6
            break
          case 's': y = mid + amp * 0.5 + Math.sin(t * Math.PI) * amp * 1.2; break
          case 't': y = mid - Math.pow(t, 0.7) * Math.pow(1 - t, 1.5) * amp * 1.2; break
        }
        pts.push(`${xJittered.toFixed(1)},${y.toFixed(2)}`)
      }
    }
    cycleIndex++
  }
  return pts.join(' ')
}

function fmtSize(n: number) {
  if (n >= 1_000_000) { const m = n / 1_000_000; return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M` }
  if (n >= 1_000) { const k = n / 1_000; return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1)}K` }
  return `${n}`
}

export default function StatusBar() {
  const tokensUsed = useStore(s => s.liveTokensUsed) || 0
  const tokensMax = useStore(s => s.liveTokensMax) || 128
  const cacheHit = useStore(s => s.liveCacheHit) || 0
  const ekgGreen = useStore(s => s.ekgGreen)
  const ekgYellow = useStore(s => s.ekgYellow)
  const ekgRed = useStore(s => s.ekgRed)
  const [tick, setTick] = useState(0)
  const ccStyle = useStore(s => s.ccStyle) || 'wave'
  const tokenDisplay = useStore(s => s.tokenDisplay)

  useEffect(() => {
    const id = setInterval(() => setTick(p => p + 1), 50)
    return () => clearInterval(id)
  }, [])

  const used = Math.max(0, Math.min(1, tokensMax > 0 ? tokensUsed / tokensMax : 0))
  const pct = Math.round(used * 100)
  const color = used < 0.50 ? (ekgGreen||'#34d399') : used < 0.80 ? (ekgYellow||'#fbbf24') : (ekgRed||'#f87171')
  const intensity = Math.min(1, used * 1.5)
  const ampMax = useStore(s => s.ekgAmplitudeMax) || 10
  const speedMax = useStore(s => s.ekgSpeedMax) || 2.0

  const W = useStore(s => s.ekgWidth) || 150
  const H = 30, mid = H / 2
  const cut = Math.max(4, W * Math.max(0, Math.min(1, 1 - used)))
  const offsetSpeed = (useStore(s => s.ekgSpeedBase) || 0.5) + intensity * speedMax
  const offset = tick * offsetSpeed
  const noiseScale = used < 0.50
    ? 0.1 + Math.sin(tick * 0.1) * 0.05
    : used < 0.80
      ? 0.3 + intensity * 0.8
      : 0.6 + intensity * 1.5
  const wfAnimated = useMemo(() => wave(W, H, intensity, offset, ampMax, noiseScale), [intensity, tick, ampMax, noiseScale])

  return (
    <div className="status-bar">
      {ccStyle === 'bar' && (
        <div className="ekg-bar" style={{
          '--bar-fill': `${pct}%`,
          '--bar-color': color,
        } as React.CSSProperties}>
          <div className="ekg-bar-fill" />
          <div className="ekg-bar-track" />
        </div>
      )}
      {ccStyle !== 'bar' && ccStyle !== 'numeric' && tokenDisplay !== 'numeric' && (
        <svg viewBox={`0 0 ${W} ${H}`} className="ekg-svg" preserveAspectRatio="none">
          <defs>
            <linearGradient id="baseline-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor={color} />
              <stop offset={cut / W} stopColor={color} />
              <stop offset={cut / W} stopColor="rgba(0,0,0,0.08)" />
              <stop offset="1" stopColor="rgba(0,0,0,0.08)" />
            </linearGradient>
          </defs>
          <line x1="0" y1={mid} x2={W} y2={mid} stroke="url(#baseline-grad)" strokeWidth="5" />
          <clipPath id="active"><rect x="0" y="0" width={cut} height={H}/></clipPath>
          <polyline points={wfAnimated} fill="none" stroke={color} strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round" clipPath="url(#active)"
            style={{ filter: `drop-shadow(0 0 4px ${color}99)` } as any}/>
          <line x1="0" y1={mid-10} x2="0" y2={mid+10} stroke="rgba(0,0,0,0.35)" strokeWidth="2"/>
          <line x1="3" y1={mid-10} x2="3" y2={mid+10} stroke="rgba(0,0,0,0.35)" strokeWidth="2"/>
          <line x1={W} y1={mid-10} x2={W} y2={mid+10} stroke="rgba(0,0,0,0.35)" strokeWidth="2"/>
          <line x1={W-3} y1={mid-10} x2={W-3} y2={mid+10} stroke="rgba(0,0,0,0.35)" strokeWidth="2"/>
          <line x1={cut} y1={mid-10} x2={cut} y2={mid+10} stroke={color} strokeWidth="3"/>
        </svg>
      )}

      <span className="ekg-pct" style={{ color }}>{pct}%</span>
      <span className="pill-mono">{fmtSize(tokensUsed)}/{fmtSize(tokensMax)}</span>
      {cacheHit > 0 && <span className="pill-mono" style={{ color: '#34d399' }}>{cacheHit}% hit</span>}
    </div>
  )
}
