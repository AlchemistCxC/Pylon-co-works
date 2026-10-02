/** @jsxImportSource solid-js */
import { LucideIcon } from '../components/LucideIcon.solid.tsx'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'
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
// #515：React → Solid 实体（OverviewSheetView.solid 直连）；DOM 结构逐字节保持。
export default function TacticalCommandDeck(props: Props) {
  // selector ⚠️ 约定：逐字段选取。identity selector 在 solidStoreKernel 恒定根引用下
  // 永不传播（历史 P0 同族：Settings.solid，#520 A2 轮复现于本文件）。
  const artwork = createZustandSignal(useTacticalSceneStore, state => state.artwork)
  const opacity = createZustandSignal(useTacticalSceneStore, state => state.opacity)
  const motion = createZustandSignal(useTacticalSceneStore, state => state.motion)
  return <section class="tactical-deck" aria-label="战术指挥台">
    <div class="tactical-identity">
      <div class="tactical-channel"><span /> PYLON / FIELD TERMINAL</div>
      <div class="tactical-identity-copy">
        <span class="tactical-micro">MIDNIGHT / WORKSPACE</span>
        <h1>你的下一次<br /><em>行动。</em></h1>
        <p>接续思考，进入工作。<br />所有会话，都有迹可循。</p>
      </div>
      <div class="tactical-live"><LucideIcon name="Activity" size={15} /><span>{props.connected} / {props.agents} Agent 已连接</span></div>
    </div>
    <nav class="tactical-tiles" aria-label="战术功能导航">
      <button class="tactical-tile tactical-operation" disabled={props.busy} onClick={() => props.onPrimary()}>
        <span class="tactical-micro">01 / OPERATION</span><LucideIcon name="ArrowUpRight" class="tactical-tile-icon" size={42} aria-hidden="true" />
        <strong class="tactical-display" aria-hidden="true">TERMINAL</strong>
        <span class="tactical-action-label">{props.busy ? '正在进入…' : props.primaryLabel}</span><small>{props.primaryDescription}</small>
      </button>
      <button class="tactical-tile tactical-agents" onClick={() => props.onPanel('agents')}>
        <span class="tactical-micro">02 / OPERATORS</span><LucideIcon name="Bot" class="tactical-tile-icon" size={34} aria-hidden="true" />
        <strong class="tactical-display" aria-hidden="true">OPERATORS</strong><span class="tactical-action-label">Agent 编队</span><small>{props.agents} 个运行时 · 选择与连接</small>
      </button>
      <button class="tactical-tile tactical-history" onClick={() => props.onPanel('recent')}>
        <span class="tactical-micro">03 / ARCHIVE</span><LucideIcon name="MessageSquare" class="tactical-tile-icon" size={28} aria-hidden="true" />
        <strong class="tactical-display" aria-hidden="true">ARCHIVE</strong><span class="tactical-action-label">会话档案</span><small>{props.sessions} 个最近会话</small>
      </button>
      <button class="tactical-tile tactical-workspaces" onClick={() => props.onPanel('workspaces')}>
        <span class="tactical-micro">04 / BASE</span><LucideIcon name="Folder" class="tactical-tile-icon" size={34} aria-hidden="true" />
        <strong class="tactical-display" aria-hidden="true">BASE</strong><span class="tactical-action-label">工作区</span><small>{props.workspaces} 个项目 · 继续工作</small>
      </button>
      <button class="tactical-tile tactical-settings" onClick={() => props.onSettings()}>
        <LucideIcon name="Settings2" size={23} aria-hidden="true" /><strong class="tactical-display" aria-hidden="true">CONFIG</strong><span class="tactical-action-label">Agent 配置</span><small>运行时与连接</small>
      </button>
      <button class="tactical-tile tactical-diagnostics" onClick={() => props.onDiagnostics()}>
        <LucideIcon name="Activity" size={22} aria-hidden="true" /><strong>运行诊断</strong><small>状态 / 日志</small>
      </button>
    </nav>
    <footer class="tactical-deck-footer">
      <span>PYLON / 蓝调战术</span>
      <details class="tactical-scene-settings"><summary>场景与动效</summary><div class="tactical-scene-options">
        <span>背景画面</span><div class="tactical-artwork-choices">
          <button type="button" aria-pressed={artwork() === 'closer'} onClick={() => useTacticalSceneStore.getState().setArtwork('closer')}>凝视 / CLOSER</button>
          <button type="button" aria-pressed={artwork() === 'falling'} onClick={() => useTacticalSceneStore.getState().setArtwork('falling')}>坠落 / FALLING</button>
        </div>
        <label>背景强度 <output>{Math.round(opacity() * 100)}%</output><input aria-label="背景强度" type="range" min="15" max="70" value={Math.round(opacity() * 100)} onInput={event => useTacticalSceneStore.getState().setOpacity(Number(event.currentTarget.value) / 100)} /></label>
        <label class="tactical-motion-control"><input type="checkbox" checked={motion()} onInput={event => useTacticalSceneStore.getState().setMotion(event.currentTarget.checked)} />背景视差与缓动</label>
        <small>仅用于蓝调战术；尊重系统减少动态效果设置。</small>
      </div></details>
    </footer>
  </section>
}
