import { useMemo, useState, useEffect } from 'react'
import { useStore } from '../../store'
import { invoke } from '@tauri-apps/api/core'
import './StatusBar.css'

function wave(w: number, h: number, intensity: number, offset: number, ampMax: number, speedMax: number, noiseScale: number): string {
  const mid = h / 2
  const amp = 3 + intensity * ampMax
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
        y += (Math.random() - 0.5) * 2 * noiseScale
        pts.push(`${x.toFixed(1)},${y.toFixed(2)}`)
      }
    }
  }
  return pts.join(' ')
}

const MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const
const MODES = ['default', 'edit', 'auto', 'bypass'] as const
type Mode = typeof MODES[number]

function fmtSize(n: number) {
  if (n >= 1_000_000) { const m = n / 1_000_000; return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M` }
  if (n >= 1_000) { const k = n / 1_000; return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1)}K` }
  return `${n}`
}

export default function StatusBar() {
  const tokensUsed = useStore(s => s.liveTokensUsed) || 0
  const tokensMax = useStore(s => s.liveTokensMax) || 128
  const cacheHit = useStore(s => s.liveCacheHit) || 0
  const mode = useStore(s => s.liveMode) || 'auto'
  const prismOn = useStore(s => s.livePrismOn)
  const ekgGreen = useStore(s => s.ekgGreen)
  const ekgYellow = useStore(s => s.ekgYellow)
  const ekgRed = useStore(s => s.ekgRed)
  const [tick, setTick] = useState(0)
  const [modelOpen, setModelOpen] = useState(false)
  const activeProfile = useStore(s => s.profiles.find(x => x.id === s.activeProfileId))
  const model = activeProfile?.model || 'deepseek-v4-flash'
  const ccStyle = useStore(s => s.ccStyle) || 'wave'
  const tokenDisplay = useStore(s => s.tokenDisplay)

  useEffect(() => {
    const id = setInterval(() => setTick(p => p + 1), 30)
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
  // V3: left=remaining(color), right=consumed(gray)
  const cut = Math.max(4, W * Math.max(0, Math.min(1, 1 - used)))
  const offsetSpeed = (useStore(s => s.ekgSpeedBase) || 0.5) + intensity * speedMax
  const offset = (tick * offsetSpeed) % (W * 0.5)
  const noiseScale = 0.1 + intensity * 0.5
  const wfAnimated = useMemo(() => wave(W, H, intensity, offset, ampMax, speedMax, noiseScale), [intensity, tick, ampMax, speedMax])

  const cycleMode = () => {
    const idx = MODES.indexOf(mode as Mode)
    const next = MODES[(idx + 1) % MODES.length]
    useStore.getState().setLiveStats({ liveMode: next })
  }

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
          {/* Layer 1: gradient baseline */}
          <line x1="0" y1={mid} x2={W} y2={mid} stroke="url(#baseline-grad)" strokeWidth="5" />
          {/* Layer 2: clipped wave */}
          <clipPath id="active"><rect x="0" y="0" width={cut} height={H}/></clipPath>
          <polyline points={wfAnimated} fill="none" stroke={color} strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round" clipPath="url(#active)"
            style={{ filter: `drop-shadow(0 0 4px ${color}99)` } as any}/>
          {/* Layer 3: left dual endpoint */}
          <line x1="0" y1={mid-10} x2="0" y2={mid+10} stroke="rgba(0,0,0,0.35)" strokeWidth="2"/>
          <line x1="3" y1={mid-10} x2="3" y2={mid+10} stroke="rgba(0,0,0,0.35)" strokeWidth="2"/>
          {/* Layer 4: right dual endpoint */}
          <line x1={W} y1={mid-10} x2={W} y2={mid+10} stroke="rgba(0,0,0,0.35)" strokeWidth="2"/>
          <line x1={W-3} y1={mid-10} x2={W-3} y2={mid+10} stroke="rgba(0,0,0,0.35)" strokeWidth="2"/>
          {/* Layer 5: moving endpoint */}
          <line x1={cut} y1={mid-10} x2={cut} y2={mid+10} stroke={color} strokeWidth="3"/>
        </svg>
      )}

      <span className="ekg-pct" style={{ color }}>{pct}%</span>
      <span className="pill-mono">{fmtSize(tokensUsed)}/{fmtSize(tokensMax)}</span>
      {cacheHit > 0 && <span className="pill-mono" style={{ color: '#34d399' }}>{cacheHit}% hit</span>}

      <span style={{ marginLeft:'auto' }} />

      <div className="model-dropdown" onClick={e => e.stopPropagation()}>
        <button className="model-tag" onClick={() => setModelOpen(!modelOpen)}>{model} ▾</button>
        {modelOpen && (
          <div className="model-menu">
            {MODELS.map(m => (
              <div key={m} className={`model-item ${m === model ? 'active' : ''}`}
                onClick={() => { useStore.getState().addProfile({ ...(activeProfile || { id: '', name: '', persona: '', model: '' }), model: m }); setModelOpen(false) }}>
                {m}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mode-switch" onClick={e => { e.stopPropagation(); cycleMode() }}>
        <span className="mode-label">{mode}</span>
        <span className="mode-cycle">↻</span>
      </div>
    </div>
  )
}
