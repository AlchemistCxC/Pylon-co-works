import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import { formatTokenCount } from '../../../tokenFormat.ts'
import { CC_WIDGET_IDS, WIDGET_PROPERTY_FIELDS, isExternalSubmitMode, isWidgetVisible, type CcPropertyCommand, type CcWidgetId, type WidgetPropertyField } from '../../../domains/cc/widgetDefinitions.ts'
import type { CcSlot, CcWidgetPlacement } from '../../../ccLayoutState.ts'
import { resolveCcMinHeight, resolveVisibleStatusWidgetCount } from '../../../ccHeightState.ts'
import type { UsageSnapshot } from '../../../domains/workbench/session/sessionSurface.ts'
import { useSolidWorkbench } from '../SolidWorkbenchContext.solid.tsx'
import { SolidInputBar } from './InputBar.solid.tsx'
import { SolidAttachWidget, SolidModeWidget, SolidModelWidget, SolidSendWidget } from './WorkbenchWidgets.solid.tsx'

const STATUS_SLOTS: readonly Exclude<CcSlot, 'input'>[] = ['status-secondary', 'status-primary', 'actions']
const WIDGET_LABELS: Readonly<Record<CcWidgetId, string>> = {
  input: '输入栏', session: '当前会话', workspace: '工作区', activity: '运行状态',
  ekg: '用量条', pct: '百分比', tokens: 'Token数', model: '模型', mode: '权限模式',
  send: '发送按钮', attach: '附件按钮', tasks: '任务',
}

export function SolidControlCenter() {
  const workbench = useSolidWorkbench()
  const appearance = () => workbench.appearanceSnapshot()
  const runtime = () => workbench.runtimeSnapshot()
  const input = () => workbench.input()
  const [selected, setSelected] = createSignal<CcWidgetId>()
  let stopDragging: (() => void) | undefined
  onCleanup(() => stopDragging?.())
  createEffect(() => {
    if (appearance().ccEditMode) return
    setSelected(undefined)
    stopDragging?.()
  })
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !appearance().ccEditMode) return
      if (selected()) setSelected(undefined)
      else {
        stopDragging?.()
        workbench.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: false })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })
  const readonly = () => input().preview === true || input().replayReadonly === true
  const externalButtonMode = () => isExternalSubmitMode({
    inputMode: appearance().inputMode,
    submitButtonMode: appearance().inputSubmitButtonMode,
  })
  const externalSend = () => externalButtonMode() && !appearance().ccHidden.includes('send')
  const externalAttach = () => externalButtonMode() && !appearance().ccHidden.includes('attach')
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
        return <SolidInputBar externalSend={externalSend()} externalAttach={externalAttach()} disabled={readonly()} predictionProvider={workbench.predictionProvider} />
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
      class={`cc-widget${id === 'input' ? '' : ' cc-natural'}${appearance().ccEditMode ? ' cc-edit' : ''}${appearance().ccHidden.includes(id) ? ' cc-hidden' : ''}${selected() === id ? ' cc-selected' : ''}`}
      data-widget-id={id}
      data-widget-slot={placement().slot}
      style={placementStyle(placement())}
      onPointerDown={event => beginDrag(event, id)}
    >{body}</div>
  }

  const beginDrag = (event: PointerEvent, id: CcWidgetId) => {
    if (!appearance().ccEditMode) return
    event.preventDefault()
    event.stopPropagation()
    setSelected(id)
    stopDragging?.()
    const startX = event.clientX
    const startY = event.clientY
    const pointerId = event.pointerId
    const start = appearance().ccLayout.placements[id]
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      workbench.appearance.dispatch({
        type: 'update-cc-placement', id,
        placement: {
          offsetX: start.offsetX + next.clientX - startX,
          offsetY: start.offsetY + next.clientY - startY,
        },
      })
    }
    const stop = (next?: PointerEvent) => {
      if (next && next.pointerId !== pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      if (stopDragging === stop) stopDragging = undefined
    }
    stopDragging = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const updatePlacement = (id: CcWidgetId, placement: Partial<CcWidgetPlacement>) => {
    workbench.appearance.dispatch({ type: 'update-cc-placement', id, placement })
  }
  const beginHeightDrag = (event: PointerEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const pointerId = event.pointerId
    const startHeight = appearance().ccHeight
    stopDragging?.()
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      workbench.appearance.dispatch({ type: 'set-cc-height', height: startHeight + startY - next.clientY })
    }
    const stop = (next?: PointerEvent) => {
      if (next && next.pointerId !== pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      if (stopDragging === stop) stopDragging = undefined
    }
    stopDragging = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }
  const setProperty = (command: CcPropertyCommand) => workbench.appearance.dispatch(command)
  const propertyFields = (id: CcWidgetId) => WIDGET_PROPERTY_FIELDS[id].filter(field => !field.showIf || field.showIf({
    inputMode: appearance().inputMode,
    ccStyle: appearance().ccStyle,
    barFillFollow: appearance().ccProperties.barFillFollow,
  }))
  const renderPropertyField = (field: WidgetPropertyField, index: number): JSX.Element => {
    if (field.kind === 'section') return <div class="cc-prop-sec" data-field-index={index}>{field.title}</div>
    const value = () => appearance().ccProperties[field.key]
    if (field.kind === 'color') return <div class="cc-prop-field"><label>{field.label}</label><input type="text" class="set-color-input" aria-label={field.label} value={String(value())} onChange={event => setProperty({ type: 'set-cc-property', key: field.key, value: event.currentTarget.value })} /></div>
    if (field.kind === 'number') return <div class="cc-prop-field"><label>{field.label}</label><input type="number" class="set-num" aria-label={field.label} value={Number(value())} min={field.min} max={field.max} step={field.step ?? 1} onInput={event => {
      const next = event.currentTarget.valueAsNumber
      if (Number.isFinite(next)) setProperty({ type: 'set-cc-property', key: field.key, value: Math.max(field.min, Math.min(field.max, next)) })
    }} />{field.suffix && <span>{field.suffix}</span>}</div>
    if (field.kind === 'chips') return <div class="cc-prop-field"><label>{field.label}</label><div class="set-preset-row"><For each={field.options}>{option => (
      <button type="button" class={`set-preset-chip${value() === option.value ? ' active' : ''}`} onClick={() => {
        setProperty({ type: 'set-cc-property', key: field.key, value: option.value })
        if (option.sync) setProperty({ type: 'set-cc-property', key: option.sync.key, value: option.sync.value })
      }}>{option.label}</button>
    )}</For></div></div>
    return <div class="cc-prop-field"><label>{field.label}</label><div class="set-preset-row">
      <button type="button" class={`set-preset-chip${value() !== false ? ' active' : ''}`} onClick={() => setProperty({ type: 'set-cc-property', key: field.key, value: true })}>{field.trueLabel}</button>
      <button type="button" class={`set-preset-chip${value() === false ? ' active' : ''}`} onClick={() => setProperty({ type: 'set-cc-property', key: field.key, value: false })}>{field.falseLabel}</button>
    </div></div>
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
    <Show when={appearance().ccEditMode}><div
      class="cc-edit-hdr"
      role="separator"
      aria-label="调整中控高度"
      aria-orientation="horizontal"
      aria-valuemin={minHeight()}
      aria-valuemax="400"
      aria-valuenow={appearance().ccHeight}
      tabIndex="0"
      onPointerDown={beginHeightDrag}
      onKeyDown={event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        workbench.appearance.dispatch({ type: 'set-cc-height', height: appearance().ccHeight + (event.key === 'ArrowUp' ? 4 : -4) })
      }}
    ><div class="cc-edit-hdr-bar" /><span class="cc-edit-hdr-label">{appearance().ccHeight}px</span></div></Show>
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
    <Show when={appearance().ccEditMode && selected()}>{id => (
      <div class="cc-prop-panel" role="dialog" aria-label={`${WIDGET_LABELS[id()]} 属性`}>
        <div class="cc-prop-header"><span>{WIDGET_LABELS[id()]}</span><button type="button" aria-label="关闭属性面板" onClick={() => setSelected(undefined)}>✕</button></div>
        <div class="cc-prop-body">
          <div class="cc-prop-sec">布局</div>
          <div class="cc-prop-field"><label>槽位</label><select class="set-select" aria-label="控件槽位" value={appearance().ccLayout.placements[id()].slot} onChange={event => updatePlacement(id(), { slot: event.currentTarget.value as CcSlot })}>
            <option value="input">输入栏</option><option value="status-primary">状态左</option><option value="status-secondary">状态右</option><option value="actions">操作区</option>
          </select></div>
          <div class="cc-prop-field"><label>顺序</label><input type="number" class="set-num" aria-label="控件顺序" min="0" max="99" step="1" value={appearance().ccLayout.placements[id()].order} onInput={event => {
            const value = event.currentTarget.valueAsNumber
            if (Number.isFinite(value)) updatePlacement(id(), { order: value })
          }} /></div>
          <div class="cc-prop-field"><label>水平微调</label><input type="number" class="set-num" aria-label="水平微调" min="-48" max="48" step="1" value={appearance().ccLayout.placements[id()].offsetX} onInput={event => {
            const value = event.currentTarget.valueAsNumber
            if (Number.isFinite(value)) updatePlacement(id(), { offsetX: value })
          }} /><span>px</span></div>
          <div class="cc-prop-field"><label>垂直微调</label><input type="number" class="set-num" aria-label="垂直微调" min="-16" max="16" step="1" value={appearance().ccLayout.placements[id()].offsetY} onInput={event => {
            const value = event.currentTarget.valueAsNumber
            if (Number.isFinite(value)) updatePlacement(id(), { offsetY: value })
          }} /><span>px</span></div>
          <Show when={id() !== 'input'}><div class="cc-prop-field"><label>缩放</label><input type="number" class="set-num" aria-label="控件缩放" min="50" max="200" step="5" value={appearance().ccScale[id()] ?? 100} onInput={event => {
            const value = event.currentTarget.valueAsNumber
            if (Number.isFinite(value)) workbench.appearance.dispatch({ type: 'set-cc-scale', id: id(), scale: value })
          }} /><span>%</span></div></Show>
          <For each={propertyFields(id())}>{(field, index) => renderPropertyField(field, index())}</For>
        </div>
        <div class="cc-prop-footer"><button type="button" class="ps-btn sm" onClick={() => {
          setSelected(undefined)
          workbench.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: false })
        }}>退出自定义</button></div>
      </div>
    )}</Show>
    <Show when={appearance().ccEditMode}>
      <div class="cc-edit-toolbar" role="toolbar" aria-label="中控控件工具栏">
        <span class="cc-edit-toolbar-label">控件</span>
        <For each={CC_WIDGET_IDS}>{id => {
          const hidden = () => appearance().ccHidden.includes(id)
          return <span class={`cc-edit-toolbar-chip-wrap${selected() === id ? ' active' : ''}${hidden() ? ' dim' : ''}`}>
            <button type="button" class="cc-edit-toolbar-chip" aria-label={`${WIDGET_LABELS[id]} 属性`} onClick={() => setSelected(id)}>{hidden() ? '＋' : '●'} {WIDGET_LABELS[id]}</button>
            <button type="button" class="cc-chip-toggle" aria-label={`${hidden() ? '显示' : '隐藏'} ${WIDGET_LABELS[id]}`} onClick={() => workbench.appearance.dispatch({ type: 'set-cc-hidden', id, hidden: !hidden() })}>{hidden() ? '显示' : '隐藏'}</button>
          </span>
        }}</For>
        <button type="button" class="cc-edit-toolbar-btn" aria-label="重置控件位置" onClick={() => workbench.appearance.dispatch({ type: 'reset-cc-layout' })}>↺ 重置位置</button>
        <button type="button" class="cc-edit-toolbar-btn danger" aria-label="退出中控编辑" onClick={() => {
          setSelected(undefined)
          workbench.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: false })
        }}>退出编辑</button>
      </div>
    </Show>
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
