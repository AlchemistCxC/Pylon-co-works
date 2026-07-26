import { useMemo, useState, useEffect } from 'react'
import { useStore } from '../../store'
import './StatusBar.css'

/**
 * 心电图 wave — 重新设计
 *
 * 设计目标：
 *   - 左端点持续发出永不重复的行波到达右动端点（不可见，因为它被右动端点"吞掉"）
 *   - 右动端点 = 用过的 token 边界；剩余空间是待消耗的"健康区"
 *   - 用量越高（used → 1）：
 *       * 波速更快     (ekgSpeedBase + used² * ekgSpeedMax)
 *       * 振幅更陡     (指数曲线：3 + used^1.4 * ekgAmplitudeMax)
 *       * 噪声强度更高  (像素级可见，不是 0.04 像素)
 *       * 颜色变红      (绿→黄→红三段)
 *   - 左端点 = 双竖线（电容符号 ‖），表示"信号发射端"
 *   - 右动端点 = 单竖线 + 微辉光，表示"信号到达 + 消耗前沿"
 */

// ── 伪随机 hash ───────────────────────────────────────────────
function hash(seed: number): number {
  return ((Math.sin(seed * 127.1) * 43758.5453) % 1 + 1) % 1
}

// ── P-Q-R-S-T 波形相位定义 ─────────────────────────────────────
// 单个心动周期分成 8 个相位（标准化为 0..1）
type Phase = { start: number; end: number; type: 'p'|'q'|'r'|'s'|'t'|'flat' }
const PHASES: Phase[] = [
  { start:0.00, end:0.08, type:'p' },
  { start:0.08, end:0.20, type:'flat' },
  { start:0.20, end:0.22, type:'q' },
  { start:0.22, end:0.25, type:'r' },
  { start:0.25, end:0.30, type:'s' },
  { start:0.30, end:0.45, type:'flat' },
  { start:0.45, end:0.65, type:'t' },
  { start:0.65, end:1.00, type:'flat' },
]

// ── 单个相位 → 归一化 y 偏移 (mid=0) ──────────────────────────
function phaseY(type: Phase['type'], t: number, amp: number): number {
  switch (type) {
    case 'p':     return -Math.pow(t, 2) * Math.pow(1-t, 0.6) * amp * 0.8
    case 'flat':  return 0
    case 'q':     return t * amp * 0.5
    case 'r':
      // 锐利双峰（R 波陡升陡降）
      return t < 0.5 ? t * 2 * amp * 2.0 : (1 - t) * 2 * amp * 1.6
    case 's':     return amp * 0.5 + Math.sin(t * Math.PI) * amp * 1.2
    case 't':     return -Math.pow(t, 0.7) * Math.pow(1-t, 1.5) * amp * 1.2
  }
}

// ── 主波形生成 ────────────────────────────────────────────────
function wave(
  W: number,           // 视图宽度
  H: number,           // 视图高度
  intensity: number,   // 0..1 (归一化 token 用量)
  offset: number,      // 动画累计偏移（像素）
  ampMax: number,
  noiseAmp: number,    // 像素级噪声强度
  cycleBase: number,   // 周期基础宽度
): string {
  const mid = H / 2
  // 振幅 = 基础 + 指数型强度影响；高用量时显著放大
  const amp = 3 + Math.pow(intensity, 1.4) * ampMax
  // 周期长度有 R-R 间期变异（呼吸式 jitter）
  const cycleW = cycleBase + Math.sin(offset * 0.012) * 6

  const pts: string[] = []
  // 从右动端点左侧（已知已消耗部分）开始，向左回溯生成完整周期
  // 但我们想让波"从左往右流出"——所以从最左往右铺若干完整周期
  let cycleIdx = Math.floor(-offset / cycleW)

  while (true) {
    const rri = Math.sin(cycleIdx * 0.7 + offset * 0.015) * 6
    const cw = cycleW + rri
    const xStart = cycleIdx * cycleW + offset

    if (xStart > W + cycleW * 2) break

    for (const ph of PHASES) {
      const steps = Math.max(2, Math.floor((ph.end - ph.start) * cw / 3))
      for (let s = 0; s <= steps; s++) {
        const t = s / Math.max(1, steps)
        const phT = ph.start + t * (ph.end - ph.start)
        const x = xStart + phT * cw
        if (x < -10 || x > W + 10) continue

        // 像素级可见的 jitter
        const j = (hash(Math.floor(x * 100 + cycleIdx * 1000)) - 0.5) * 2 * noiseAmp
        const xJ = x + j
        if (xJ < -10 || xJ > W + 10) continue

        const y = mid + phaseY(ph.type, t, amp)
        pts.push(`${xJ.toFixed(1)},${y.toFixed(2)}`)
      }
    }
    cycleIdx++
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

  // 振幅/速度的非线性影响
  const ampMax = useStore(s => s.ekgAmplitudeMax) || 14
  const speedMax = useStore(s => s.ekgSpeedMax) || 3.5
  const speedBase = useStore(s => s.ekgSpeedBase) || 0.6
  const W = useStore(s => s.ekgWidth) || 140
  const H = 30, mid = H / 2
  const lineW = useStore(s => s.ekgLineWidth) || 2

  // 右动端点位置：剩余 token = 未消耗 = (1 - used) 从右往左数
  const cut = Math.max(4, W * Math.max(0, 1 - used))

  // 速度 = 基础 + 二次型强度（高用量时更陡）
  const offsetSpeed = speedBase + used * used * speedMax * 3
  const offset = tick * offsetSpeed

  // 噪声 = 像素级（不是 0.04px）
  const noiseAmp = used < 0.50
    ? 0.4 + Math.sin(tick * 0.1) * 0.2
    : used < 0.80
      ? 1.2 + used * 2.5
      : 2.5 + used * 4.0

  // 周期宽度：低用量时周期长（舒缓），高用量时压缩
  const cycleBase = 70 - used * 25

  const wfAnimated = useMemo(
    () => wave(W, H, used, offset, ampMax, noiseAmp, cycleBase),
    [used, tick, ampMax, noiseAmp, cycleBase]
  )

  const showWave = ccStyle !== 'bar' && ccStyle !== 'numeric' && tokenDisplay !== 'numeric'
  const showBar = ccStyle === 'bar'
  const showNumeric = ccStyle === 'numeric' || tokenDisplay === 'numeric'

  return (
    <div className="status-bar">
      {showBar && (
        <div className="ekg-bar" style={{
          '--bar-fill': `${pct}%`,
          '--bar-color': color,
        } as React.CSSProperties}>
          <div className="ekg-bar-track" />
          <div className="ekg-bar-fill" />
        </div>
      )}

      {showWave && (
        <svg viewBox={`0 0 ${W} ${H}`} className="ekg-svg" preserveAspectRatio="none">
          <defs>
            {/* 基线渐变：左端（已消耗）= 灰，右端（健康区）= 全色 */}
            <linearGradient id="baseline-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="rgba(255,255,255,0.04)" />
              <stop offset={cut / W} stopColor="rgba(255,255,255,0.04)" />
              <stop offset={cut / W} stopColor={color} />
              <stop offset="1" stopColor={color} />
            </linearGradient>
            {/* 波形 clip：只渲染到 cut 处（已消耗区的"幽灵轨迹"被截断） */}
            <clipPath id="ekg-active"><rect x="0" y="0" width={cut} height={H}/></clipPath>
          </defs>

          {/* 基线 */}
          <line x1="0" y1={mid} x2={W} y2={mid} stroke="url(#baseline-grad)" strokeWidth={lineW} />

          {/* 波形本身（只渲染在 cut 范围内） */}
          <polyline points={wfAnimated} fill="none" stroke={color} strokeWidth={lineW}
            strokeLinecap="round" strokeLinejoin="round"
            clipPath="url(#ekg-active)"
            style={{ filter: `drop-shadow(0 0 ${1 + used * 2}px ${color}88)` } as any}/>

          {/* 左端点：电容符号 ‖ （两条等高竖线） */}
          <line x1={1.5} y1={mid - 8} x2={1.5} y2={mid + 8} stroke={color} strokeWidth={lineW + 0.5} opacity="0.85"/>
          <line x1={5}   y1={mid - 8} x2={5}   y2={mid + 8} stroke={color} strokeWidth={lineW + 0.5} opacity="0.85"/>

          {/* 右动端点：单竖线 + 辉光（用量越高辉光越强） */}
          <line x1={cut} y1={mid - 9} x2={cut} y2={mid + 9} stroke={color} strokeWidth={lineW + 1}
            style={{ filter: `drop-shadow(0 0 ${2 + used * 4}px ${color})` } as any}/>
        </svg>
      )}

      <span className="ekg-pct" style={{ color }}>{pct}%</span>

      {showNumeric && (
        <span className="pill-mono">{fmtSize(tokensUsed)}/{fmtSize(tokensMax)}</span>
      )}
      {!showNumeric && (
        <span className="pill-mono">{fmtSize(tokensUsed)}/{fmtSize(tokensMax)}</span>
      )}

      {cacheHit > 0 && <span className="pill-mono" style={{ color: '#34d399' }}>{cacheHit}% hit</span>}
    </div>
  )
}