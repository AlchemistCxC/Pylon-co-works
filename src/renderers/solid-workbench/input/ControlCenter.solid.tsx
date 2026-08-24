import { For, Match, Show, Switch, createMemo, type JSX } from 'solid-js'
import { formatTokenCount } from '../../../tokenFormat.ts'
import { CC_WIDGET_IDS, isExternalSubmitMode, isWidgetVisible, type CcWidgetId } from '../../../domains/cc/widgetDefinitions.ts'
import type { CcSlot, CcWidgetPlacement } from '../../../ccLayoutState.ts'
import { resolveCcMinHeight, resolveVisibleStatusWidgetCount } from '../../../ccHeightState.ts'
import type { UsageSnapshot } from '../../../domains/workbench/session/sessionSurface.ts'
import { useSolidWorkbench } from '../SolidWorkbenchContext.solid.tsx'
import { SolidInputBar } from './InputBar.solid.tsx'
import { SolidAttachWidget, SolidModeWidget, SolidModelWidget, SolidSendWidget } from './WorkbenchWidgets.solid.tsx'

const STATUS_SLOTS: readonly Exclude<CcSlot, 'input'>[] = ['status-secondary', 'status-primary', 'actions']

export function SolidControlCenter() {
  const workbench = useSolidWorkbench()
  const appearance = () => workbench.appearanceSnapshot()
  const runtime = () => workbench.runtimeSnapshot()
  const input = () => workbench.input()
  const readonly = () => input().preview === true || input().replayReadonly === true
  const externalButtons = () => isExternalSubmitMode({
    inputMode: appearance().inputMode,
    submitButtonMode: appearance().inputSubmitButtonMode,
  })
  const visibilityContext = () => ({
    hidden: appearance().ccHidden,
    inputMode: appearance().inputMode,
    submitButtonMode: appearance().inputSubmitButtonMode,
    ccStyle: appearance().ccStyle,
    editMode: appearance().ccEditMode,
    presentationProfileId: input().presentationProfileId,
  })
  const visibleIds = createMemo(() => CC_WIDGET_IDS.filter(id => isWidgetVisible(id, visibilityContext())))
  const minHeight = () => resolveCcMinHeight({
    inputMode: appearance().inputMode,
    footerLayout: appearance().footerLayout,
    hintMode: appearance().cliHintMode,
    visibleStatusWidgets: resolveVisibleStatusWidgetCount({
      hiddenIds: appearance().ccHidden,
      inputMode: appearance().inputMode,
      ccStyle: appearance().ccStyle,
      submitButtonMode: appearance().inputSubmitButtonMode,
      presentationProfileId: input().presentationProfileId,
    }),
    cliOverflowMode: appearance().cliOverflowMode,
  })
  const idsForSlot = (slot: CcSlot) => visibleIds()
    .filter(id => appearance().ccLayout.placements[id]?.slot === slot)
    .sort((left, right) => appearance().ccLayout.placements[left].order - appearance().ccLayout.placements[right].order)

  const renderBody = (id: CcWidgetId): JSX.Element | null => {
    switch (id) {
      case 'input':
        return <SolidInputBar externalSend={externalButtons()} externalAttach={externalButtons()} disabled={readonly()} />
      case 'session':
        return <span class="cc-info-chip cc-session-chip" title={input().sessionLabel ?? input().sessionId ?? '未选择会话'}>
          <span aria-hidden="true">●</span><span>{input().sessionLabel ?? input().sessionId ?? '未选择会话'}</span>
        </span>
      case 'workspace':
        return <span class="cc-info-chip cc-workspace-chip" title={input().workspacePath ?? input().workspaceLabel ?? '当前会话没有工作目录'}>
          <span aria-hidden="true">▣</span><span>{input().workspaceLabel ?? '无工作目录'}</span>
        </span>
      case 'activity':
        return <span class="cc-info-chip cc-activity-chip" data-running={runtime().generating ? 'true' : 'false'} role="status" aria-live="polite">
          <span aria-hidden="true">{runtime().generating ? '◌' : '●'}</span><span>{runtime().generating ? '生成中' : '就绪'}</span>
        </span>
      case 'ekg':
        return <SolidUsageGauge usage={runtime().document?.session.usage} fallbackTokens={runtime().tokenCount} style={appearance().ccStyle} scale={appearance().ccScale.ekg} />
      case 'pct':
        return <span class="ekg-pct" style={{ 'font-size': `${appearance().ccScale.pct ?? 100}%` }}>{Math.round(contextRatio(runtime().document?.session.usage, runtime().tokenCount) * 100)}%</span>
      case 'tokens': {
        const usage = () => runtime().document?.session.usage
        const limit = () => usage()?.contextLimit
        return <span class="pill-mono" style={{ 'border-left': 'none', padding: '0', 'font-size': `${appearance().ccScale.tokens ?? 100}%` }}>
          {formatTokenCount(usageTokenCount(usage(), runtime().tokenCount))}/{limit() && limit()! > 0 ? formatTokenCount(limit()!) : '—'}
        </span>
      }
      case 'model':
        return <SolidModelWidget />
      case 'mode':
        return <SolidModeWidget />
      case 'send':
        return <SolidSendWidget disabled={readonly()} />
      case 'attach':
        return <SolidAttachWidget disabled={readonly()} />
      case 'tasks': {
        return <Show when={taskLabel(runtime().tasks)}>{label => (
          <button type="button" class="cc-tasks-pill" title="任务列表（点击展开/收起）" onClick={() => window.dispatchEvent(new CustomEvent('pylon:tasks-toggle'))}>{label()}</button>
        )}</Show>
      }
    }
  }

  const renderWidget = (id: CcWidgetId) => {
    const placement = () => appearance().ccLayout.placements[id]
    const body = renderBody(id)
    if (body === null) return null
    return <div
      class={`cc-widget${id === 'input' ? '' : ' cc-natural'}${appearance().ccEditMode ? ' cc-edit' : ''}${appearance().ccHidden.includes(id) ? ' cc-hidden' : ''}`}
      data-widget-id={id}
      data-widget-slot={placement().slot}
      style={placementStyle(placement())}
    >{body}</div>
  }

  const statusSlots = () => <For each={STATUS_SLOTS}>{slot => (
    <div class={`cc-${slot}`} data-cc-slot={slot}>
      <For each={idsForSlot(slot)}>{renderWidget}</For>
    </div>
  )}</For>

  const commandHint = () => appearance().inputMode === 'cli' && appearance().cliHintMode !== 'hidden'
    ? <div class="cc-command-hint" aria-label="输入快捷键提示">
      <span class="cc-command-hint-key">/: 命令</span>
      <span class="cc-hint-secondary"><i>|</i> Shift+Enter: 换行</span>
      {appearance().cliHintMode === 'full' && <span class="cc-hint-tertiary"><i>|</i> Shift+Tab: 模式</span>}
    </div>
    : null

  return <div
    class={`solid-workbench-control-center-slot control-center${appearance().inputMode === 'cli' ? ' cli-mode' : ''}${appearance().ccEditMode ? ' cc-editing' : ''} cc-variant-${appearance().ccVariant}`}
    data-control-center="production"
    style={{
      '--cc-height': `${appearance().ccHeight}px`,
      '--cc-min-height': `${minHeight()}px`,
      '--cc-bg-height': `${appearance().ccBgHeight}px`,
    }}
  >
    <div class="cc-bg" />
    <div class="cc-body">
      {appearance().footerLayout === 'peri' ? <div class="cc-footer cc-footer-peri">
        <div class="cc-input-slot"><For each={idsForSlot('input')}>{renderWidget}</For></div>
        <div class="cc-footer-status">
          <div class="cc-footer-status-row">{statusSlots()}</div>
          {commandHint()}
        </div>
      </div> : <>
        <div class="cc-input-slot"><For each={idsForSlot('input')}>{renderWidget}</For></div>
        <div class="cc-status-row">{statusSlots()}{commandHint()}</div>
      </>}
    </div>
  </div>
}

function placementStyle(placement: CcWidgetPlacement): JSX.CSSProperties {
  return placement.offsetX === 0 && placement.offsetY === 0
    ? {}
    : { transform: `translate(${placement.offsetX}px, ${placement.offsetY}px)` }
}

function usageTokenCount(usage: UsageSnapshot | undefined, fallback: number): number {
  if (usage?.totalTokens !== undefined) return usage.totalTokens
  const parts = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
  return parts > 0 ? parts : Math.max(0, fallback)
}

function contextRatio(usage: UsageSnapshot | undefined, fallback: number): number {
  const explicit = usage?.contextPercent
  if (explicit !== undefined) return clamp01(explicit / 100)
  const limit = usage?.contextLimit ?? 0
  const used = usage?.contextUsed ?? usageTokenCount(usage, fallback)
  return limit > 0 ? clamp01(used / limit) : 0
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}

function SolidUsageGauge(props: { usage?: UsageSnapshot; fallbackTokens: number; style: string; scale?: number }) {
  const ratio = () => contextRatio(props.usage, props.fallbackTokens)
  const percent = () => Math.round(ratio() * 100)
  return <Switch fallback={<svg viewBox="0 0 140 30" class="ekg-svg" preserveAspectRatio="none" aria-label={`上下文 ${percent()}%`} style={{ 'font-size': `${props.scale ?? 100}%` }}>
    <rect x="0" y="12" width={140 * (1 - ratio())} height="6" rx="3" fill="currentColor" opacity="0.3" />
    <rect x={140 * (1 - ratio())} y="12" width={140 * ratio()} height="6" rx="3" fill="var(--ekg-consumed,rgba(128,128,128,0.15))" />
  </svg>}>
    <Match when={props.style === 'numeric'}><span class="ekg-pct" style={{ 'font-size': `${props.scale ?? 100}%` }}>{percent()}%</span></Match>
    <Match when={props.style === 'ring'}><span class="cc-context-ring" role="img" aria-label={`上下文 ${percent()}%`} title={`上下文 ${percent()}%`} style={{ '--context-ring-ratio': ratio(), 'font-size': `${props.scale ?? 100}%` }}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle class="cc-context-ring-track" cx="12" cy="12" r="9" pathLength="1" /><circle class="cc-context-ring-value" cx="12" cy="12" r="9" pathLength="1" /></svg>
      <span class="cc-context-ring-label">{percent()}%</span>
    </span></Match>
    <Match when={props.style === 'bar'}><div class="ekg-bar" style={{ '--bar-fill': `${percent()}%`, 'font-size': `${props.scale ?? 100}%` }}><div class="ekg-bar-track" /><div class="ekg-bar-fill" /></div></Match>
  </Switch>
}

function taskLabel(entries: readonly { readonly status: string }[]): string {
  if (entries.length === 0) return ''
  const completed = entries.filter(entry => entry.status === 'completed').length
  const active = entries.filter(entry => entry.status === 'in_progress').length
  return active > 0 ? `任务 ${completed}/${entries.length} · ${active} 进行中` : `任务 ${completed}/${entries.length}`
}
