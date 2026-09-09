import { Activity, ArrowUpRight, Bot, Folder, MessageSquare, Settings2 } from 'lucide-react'
import { useTacticalSceneStore } from './tacticalSceneStore'

export type TacticalPanel = 'home' | 'agents' | 'recent' | 'workspaces'

interface Props {
  agents: number
  connected: number
  sessions: number
  workspaces: number
  primaryLabel: string
  primaryDescription: string
  busy: boolean
  onPrimary(): void
  onPanel(panel: TacticalPanel): void
  onSettings(): void
  onDiagnostics(): void
}

/** Navigation only: all operational actions are supplied by the existing host. */
export default function TacticalCommandDeck(props: Props) {
  const scene = useTacticalSceneStore()
  return <section className="tactical-deck" aria-label="战术指挥台">
    <div className="tactical-identity">
      <div className="tactical-channel"><span /> PYLON / FIELD TERMINAL</div>
      <div className="tactical-identity-copy">
        <span className="tactical-micro">MIDNIGHT / WORKSPACE</span>
        <h1>你的下一次<br /><em>行动。</em></h1>
        <p>接续思考，进入工作。<br />所有会话，都有迹可循。</p>
      </div>
      <div className="tactical-live"><Activity size={15} /><span>{props.connected} / {props.agents} Agent 已连接</span></div>
    </div>
    <nav className="tactical-tiles" aria-label="战术功能导航">
      <button className="tactical-tile tactical-operation" disabled={props.busy} onClick={props.onPrimary}>
        <span className="tactical-micro">01 / OPERATION</span><ArrowUpRight className="tactical-tile-icon" size={42} aria-hidden="true" />
        <strong className="tactical-display" aria-hidden="true">TERMINAL</strong>
        <span className="tactical-action-label">{props.busy ? '正在进入…' : props.primaryLabel}</span><small>{props.primaryDescription}</small>
      </button>
      <button className="tactical-tile tactical-agents" onClick={() => props.onPanel('agents')}>
        <span className="tactical-micro">02 / OPERATORS</span><Bot className="tactical-tile-icon" size={34} aria-hidden="true" />
        <strong className="tactical-display" aria-hidden="true">OPERATORS</strong><span className="tactical-action-label">Agent 编队</span><small>{props.agents} 个运行时 · 选择与连接</small>
      </button>
      <button className="tactical-tile tactical-history" onClick={() => props.onPanel('recent')}>
        <span className="tactical-micro">03 / ARCHIVE</span><MessageSquare className="tactical-tile-icon" size={28} aria-hidden="true" />
        <strong className="tactical-display" aria-hidden="true">ARCHIVE</strong><span className="tactical-action-label">会话档案</span><small>{props.sessions} 个最近会话</small>
      </button>
      <button className="tactical-tile tactical-workspaces" onClick={() => props.onPanel('workspaces')}>
        <span className="tactical-micro">04 / BASE</span><Folder className="tactical-tile-icon" size={34} aria-hidden="true" />
        <strong className="tactical-display" aria-hidden="true">BASE</strong><span className="tactical-action-label">工作区</span><small>{props.workspaces} 个项目 · 继续工作</small>
      </button>
      <button className="tactical-tile tactical-settings" onClick={props.onSettings}>
        <Settings2 size={23} aria-hidden="true" /><strong className="tactical-display" aria-hidden="true">CONFIG</strong><span className="tactical-action-label">Agent 配置</span><small>运行时与连接</small>
      </button>
      <button className="tactical-tile tactical-diagnostics" onClick={props.onDiagnostics}>
        <Activity size={22} aria-hidden="true" /><strong>运行诊断</strong><small>状态 / 日志</small>
      </button>
    </nav>
    <footer className="tactical-deck-footer">
      <span>PYLON / 蓝调战术</span>
      <details className="tactical-scene-settings"><summary>场景与动效</summary><div className="tactical-scene-options">
        <span>背景画面</span><div className="tactical-artwork-choices">
          <button type="button" aria-pressed={scene.artwork === 'closer'} onClick={() => scene.setArtwork('closer')}>凝视 / CLOSER</button>
          <button type="button" aria-pressed={scene.artwork === 'falling'} onClick={() => scene.setArtwork('falling')}>坠落 / FALLING</button>
        </div>
        <label>背景强度 <output>{Math.round(scene.opacity * 100)}%</output><input aria-label="背景强度" type="range" min="15" max="70" value={Math.round(scene.opacity * 100)} onChange={event => scene.setOpacity(Number(event.target.value) / 100)} /></label>
        <label className="tactical-motion-control"><input type="checkbox" checked={scene.motion} onChange={event => scene.setMotion(event.target.checked)} />背景视差与缓动</label>
        <small>仅用于蓝调战术；尊重系统减少动态效果设置。</small>
      </div></details>
    </footer>
  </section>
}
