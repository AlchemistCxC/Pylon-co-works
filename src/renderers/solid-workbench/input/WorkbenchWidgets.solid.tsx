import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, onMount } from 'solid-js'
import { useSolidWorkbench } from '../SolidWorkbenchContext.solid.tsx'
import {
  optionLabel,
  isReasoningOption,
  resolveDocumentOptionEntries,
  resolveDocumentOptionValue,
  resolveModeOptionEntries,
  resolveModelOptionEntries,
  resolveReasoningOptionEntries,
  type WorkbenchOptionEntry,
} from './workbenchOptionCatalog.ts'

function nextValue(values: readonly string[], current: string): string {
  if (values.length === 0) return current
  const index = values.indexOf(current)
  return values[(index + 1 + values.length) % values.length] ?? values[0] ?? current
}

export function SolidModelWidget(props: {
  draftValue?: () => string
  onDraftChange?: (value: string) => void
  reasoningValue?: () => string
  onReasoningChange?: (value: string) => void
  /** Empty-state controls remain selectable with compact/badge presets. */
  forceDropdown?: boolean
} = {}) {
  const workbench = useSolidWorkbench()
  const runtime = () => workbench.runtimeSnapshot()
  const appearance = () => workbench.appearanceSnapshot()
  const [open, setOpen] = createSignal(false)
  const [error, setError] = createSignal('')
  let root: HTMLDivElement | undefined
  let trigger: HTMLButtonElement | undefined
  let previousSessionId = workbench.input().sessionId
  const menuId = `cc-model-menu-${createUniqueId()}`
  const modelEntries = () => resolveModelOptionEntries(runtime(), props.draftValue?.())
  const models = () => modelEntries().map(item => item.id)
  const model = () => props.draftValue?.() || runtime().activeModel || modelEntries()[0]?.id || '未配置模型'
  const reasoningOption = () => runtime().document?.session.options.find(isReasoningOption)
  const reasoningValue = () => props.reasoningValue?.()
    ?? resolveDocumentOptionValue(runtime().document?.session.options, 'reasoning') ?? ''
  const displayModel = () => reasoningValue() ? `${model()}（${reasoningValue()}）` : model()
  const scale = () => appearance().ccScale.model ?? 100
  const reasoningEntries = () => props.onReasoningChange
    ? resolveReasoningOptionEntries(runtime(), props.reasoningValue?.())
    : reasoningOption()?.editable === false ? []
      : resolveDocumentOptionEntries(reasoningOption() ? [reasoningOption()!] : [], 'reasoning')
  let reasoningRequest = 0
  const [reasoningPending, setReasoningPending] = createSignal(false)
  const dropdown = () => props.forceDropdown === true || appearance().modelVariant === 'dropdown'
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => trigger?.focus())
  }
  createEffect(() => {
    const currentSessionId = workbench.input().sessionId
    if (currentSessionId !== previousSessionId) {
      reasoningRequest++
      setReasoningPending(false)
      setError('')
    }
    if (currentSessionId !== previousSessionId || !dropdown()) close()
    previousSessionId = currentSessionId
  })
  onMount(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!open() || root?.contains(event.target as Node)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!open() || event.key !== 'Escape') return
      event.preventDefault()
      close(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    })
  })
  const choose = async (target: string) => {
    const sessionId = workbench.input().sessionId
    // A draft setter is an explicit empty-state (or transition-state) binding.
    // Prefer it even when the host has already published a session id: session
    // selection and renderer updates can arrive in the same tick, and sending
    // a live-session command here would race the create transaction.
    if (props.onDraftChange) { props.onDraftChange(target); close(true); return }
    if (!sessionId || target === model()) { close(true); return }
    const result = await workbench.commands.setModel(sessionId, target)
    if (!result.ok) setError(result.error || '模型切换失败')
    else setError('')
    close(true)
  }
  const chooseReasoning = async (target: string) => {
    if (props.onReasoningChange) { props.onReasoningChange(target); return }
    const sessionId = workbench.input().sessionId
    const option = reasoningOption()
    if (!sessionId || !option || option.editable === false || reasoningPending()
      || !reasoningEntries().some(entry => entry.id === target) || target === reasoningValue()) return
    const request = ++reasoningRequest
    setReasoningPending(true)
    setError('')
    try {
      const result = await workbench.commands.setConfigOption(sessionId, option.id, target, {
        expectedValue: option.value,
        ...(option.version !== undefined ? { expectedVersion: option.version } : {}),
      })
      if (request === reasoningRequest && workbench.input().sessionId === sessionId && !result.ok)
        setError(result.error || '思考等级切换失败')
    } catch (cause) {
      if (request === reasoningRequest && workbench.input().sessionId === sessionId)
        setError(cause instanceof Error ? cause.message : '思考等级切换失败')
    } finally {
      if (request === reasoningRequest) setReasoningPending(false)
    }
  }

  return (
    <div ref={node => { root = node }} class="solid-model-widget">
      <Show when={error()}>{message => <span class="cc-widget-error" role="alert">{message()}</span>}</Show>
      <Show when={dropdown() || (appearance().modelVariant !== 'badge' && appearance().modelVariant !== 'minimal')} fallback={
        <Show when={appearance().modelVariant === 'badge'} fallback={
          <button
            type="button"
            class="cc-model-minimal"
            title="点击切换模型"
            style={{ 'font-size': `${scale()}%` }}
            onClick={() => void choose(nextValue(models(), model()))}
          >{displayModel()}</button>
        }>
          <span class="cc-model-badge" style={{ 'font-size': `${scale()}%` }}>{displayModel()}</span>
        </Show>
      }>
        <ModelDropdown
          menuId={menuId}
          triggerRef={node => { trigger = node }}
          rootRef={node => { root = node }}
          open={open}
          setOpen={setOpen}
          close={close}
          scale={scale}
          displayModel={displayModel}
          model={model}
          modelEntries={modelEntries}
          reasoningEntries={reasoningEntries}
          reasoningValue={reasoningValue}
          onReasoningChange={value => void chooseReasoning(value)}
          choose={choose}
        />
      </Show>
    </div>
  )
}

function ModelDropdown(props: {
  menuId: string
  triggerRef: (node: HTMLButtonElement) => void
  rootRef: (node: HTMLDivElement) => void
  open: () => boolean
  setOpen: (value: boolean | ((previous: boolean) => boolean)) => void
  close: (restoreFocus?: boolean) => void
  scale: () => number
  displayModel: () => string
  model: () => string
  modelEntries: () => readonly WorkbenchOptionEntry[]
  reasoningEntries: () => readonly WorkbenchOptionEntry[]
  reasoningValue?: () => string
  onReasoningChange?: (value: string) => void
  choose: (value: string) => Promise<void>
}) {
  let menu: HTMLDivElement | undefined
  createEffect(() => {
    if (!props.open()) return
    queueMicrotask(() => menu?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
  })
  return <div ref={props.rootRef} class="cc-model-dropdown">
    <button
      ref={props.triggerRef}
      type="button"
      class="model-tag"
      style={{ 'font-size': `${props.scale()}%` }}
      aria-haspopup="listbox"
      aria-expanded={props.open()}
      aria-controls={props.menuId}
      onClick={() => props.setOpen(value => !value)}
    >{props.displayModel()} ▾</button>
    <Show when={props.open()}>
      <div
        ref={node => { menu = node }}
        id={props.menuId}
        class="model-menu"
        data-popover="control-center"
        role="listbox"
        aria-label="模型列表"
        tabIndex="-1"
        onKeyDown={event => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          props.close(true)
        }}
      >
        <Show when={props.reasoningValue && props.onReasoningChange && props.reasoningEntries().length > 0}>
          <div class="model-menu-section" role="group" aria-label="思考强度">
            <span>思考强度</span>
            <For each={props.reasoningEntries()}>{effort => <button
              type="button"
              role="option"
              aria-selected={effort.id === props.reasoningValue?.()}
              class={`model-item${effort.id === props.reasoningValue?.() ? ' active' : ''}`}
              tabIndex={-1}
              onClick={() => {
                props.onReasoningChange?.(effort.id)
                props.close(true)
              }}
            >{optionLabel('reasoning', effort.id, effort.label)}</button>}</For>
          </div>
        </Show>
        <For each={props.modelEntries()}>{item => (
          <button
            type="button"
            role="option"
            aria-selected={item.id === props.model()}
            class={`model-item${item.id === props.model() ? ' active' : ''}`}
            tabIndex={-1}
            onClick={() => void props.choose(item.id)}
          >{item.label || item.id}</button>
        )}</For>
      </div>
    </Show>
  </div>
}

export function SolidModeWidget(props: {
  draftValue?: () => string
  onDraftChange?: (value: string) => void
  forceDropdown?: boolean
} = {}) {
  const workbench = useSolidWorkbench()
  const runtime = () => workbench.runtimeSnapshot()
  const appearance = () => workbench.appearanceSnapshot()
  const [error, setError] = createSignal('')
  const [open, setOpen] = createSignal(false)
  let root: HTMLDivElement | undefined
  let trigger: HTMLButtonElement | undefined
  let previousSessionId = workbench.input().sessionId
  const menuId = `cc-mode-menu-${createUniqueId()}`
  const modeEntries = () => resolveModeOptionEntries(runtime(), props.draftValue?.())
  const modes = () => modeEntries().map(item => item.id)
  const mode = () => props.draftValue?.() || runtime().activeMode || modeEntries()[0]?.id || 'default'
  const scale = () => appearance().ccScale.mode ?? 100
  const dropdown = () => props.forceDropdown === true
  const displayMode = () => dropdown() ? optionLabel('mode', mode()) : mode()
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => trigger?.focus())
  }
  createEffect(() => {
    const currentSessionId = workbench.input().sessionId
    if (currentSessionId !== previousSessionId || !dropdown()) close()
    previousSessionId = currentSessionId
  })
  onMount(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!open() || root?.contains(event.target as Node)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!open() || event.key !== 'Escape') return
      event.preventDefault()
      close(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    })
  })
  let menu: HTMLDivElement | undefined
  createEffect(() => {
    if (!open()) return
    queueMicrotask(() => menu?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
  })
  const chooseMode = async (target: string) => {
    const sessionId = workbench.input().sessionId
    if (props.onDraftChange) {
      props.onDraftChange(target)
      close(true)
      return
    }
    if (!sessionId) { close(true); return }
    const result = await workbench.commands.setMode(sessionId, target)
    if (!result.ok) setError(result.error || '权限模式切换失败')
    else setError('')
    close(true)
  }
  const cycle = async () => {
    const sessionId = workbench.input().sessionId
    if (props.onDraftChange) { props.onDraftChange(nextValue(modes(), mode())); return }
    if (!sessionId) return
    const result = await workbench.commands.setMode(sessionId, nextValue(modes(), mode()))
    if (!result.ok) setError(result.error || '权限模式切换失败')
    else setError('')
  }

  return (
    <div class="solid-mode-widget">
      <Show when={error()}>{message => <span class="cc-widget-error" role="alert">{message()}</span>}</Show>
      <Show when={dropdown()} fallback={
        <Show when={appearance().modeVariant === 'badge'} fallback={
          <Show when={appearance().modeVariant === 'minimal'} fallback={
            <button type="button" class="cc-mode-widget" title="点击切换" style={{ 'font-size': `${scale()}%` }} onClick={() => void cycle()}>
              <span class="mode-pill" data-mode={mode()}>{mode()}</span>
            </button>
          }>
            <button type="button" class="cc-mode-minimal" data-mode={mode()} style={{ 'font-size': `${scale()}%` }} onClick={() => void cycle()}>{mode()}</button>
          </Show>
        }>
          <button type="button" class="cc-mode-badge" data-mode={mode()} title="点击切换" style={{ 'font-size': `${scale()}%` }} onClick={() => void cycle()}>
            [{mode()}]
          </button>
        </Show>
      }>
        <div ref={node => { root = node }} class="cc-mode-dropdown">
          <button
            ref={node => { trigger = node }}
            type="button"
            class="cc-mode-widget cc-mode-select"
            title="选择权限模式"
            style={{ 'font-size': `${scale()}%` }}
            aria-haspopup="listbox"
            aria-expanded={open()}
            aria-controls={menuId}
            onClick={() => setOpen(value => !value)}
          ><span class="mode-pill" data-mode={mode()}>{displayMode()}</span> ▾</button>
          <Show when={open()}>
            <div
              ref={node => { menu = node }}
              id={menuId}
              class="mode-menu model-menu"
              data-popover="control-center"
              role="listbox"
              aria-label="模式列表"
              tabIndex="-1"
              onKeyDown={event => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                event.stopPropagation()
                close(true)
              }}
            >
              <For each={modeEntries()}>{item => <button
                type="button"
                role="option"
                aria-selected={item.id === mode()}
                class={`model-item${item.id === mode() ? ' active' : ''}`}
                tabIndex={-1}
                onClick={() => { void chooseMode(item.id) }}
              >{optionLabel('mode', item.id, item.label)}</button>}</For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

/** Session-create reasoning preference. It uses the same compact control language
 * as the mode widget and remains available in the normal control center. */
export function SolidReasoningWidget(props: { value: () => string; onChange: (value: string) => void }) {
  return <label class="cc-reasoning-widget" title="思考强度">
    <span class="cc-reasoning-label">思考</span>
    <select aria-label="思考强度" value={props.value()} onChange={event => props.onChange(event.currentTarget.value)}>
      <option value="fast">快速</option><option value="balanced">平衡</option><option value="deep">深入</option>
    </select>
  </label>
}

/** First-batch host renderer: the registered send block includes its icon layer;
 * the effect layer (highlight/shadow) is still pending. */
export function SolidCcSendButton(props: { disabled?: boolean; mode: 'inline' | 'external' }) {
  const workbench = useSolidWorkbench()
  const appearance = () => workbench.appearanceSnapshot()
  const runtime = () => workbench.runtimeSnapshot()
  const send = () => window.dispatchEvent(new CustomEvent('pylon:solid-input-send'))
  const cancel = () => {
    const sessionId = workbench.input().sessionId
    if (sessionId) void workbench.commands.cancel(sessionId)
  }
  const icon = () => runtime().generating ? appearance().sendButtonIconGenerating : appearance().sendButtonIcon
  const round = () => appearance().sendButtonIconRound === 'on'
  const iconClass = () => {
    const value = icon()
    const solid = value === 'triangle' || value === 'square'
    return `cc-send-icon ${solid ? 'cc-send-icon--solid' : 'cc-send-icon--stroke'}${round() && !solid ? ' cc-send-icon--round' : ''}${value === 'triangle' ? ' cc-send-icon--lg' : ''}${value === 'double-arrow' ? ' cc-send-icon--double' : ''}`
  }
  const path = () => {
    const value = icon()
    if (value === 'arrow') return 'M12 20 V4.5 M5.3 11.2 L12 4.5 L18.7 11.2'
    if (value === 'double-arrow') return 'M6.5 11 L12 6.5 L17.5 11 M6.5 17.5 L12 13 L17.5 17.5'
    if (value === 'cross') return 'M6.5 6.5 L17.5 17.5 M17.5 6.5 L6.5 17.5'
    if (value === 'triangle') return round() ? 'M10.94 9.31 A1.5 1.5 0 0 1 13.06 9.31 L16.94 13.19 A1.5 1.5 0 0 1 15.88 15.75 L8.12 15.75 A1.5 1.5 0 0 1 7.06 13.19 Z' : 'M12 8.25 L19.5 15.75 H4.5 Z'
    return round() ? 'M7.5 6 H16.5 A1.5 1.5 0 0 1 18 7.5 V16.5 A1.5 1.5 0 0 1 16.5 18 H7.5 A1.5 1.5 0 0 1 6 16.5 V7.5 A1.5 1.5 0 0 1 7.5 6 Z' : 'M6 6 H18 V18 H6 Z'
  }
  return <button
    type="button"
    class="cc-send-button"
    data-mode={props.mode}
    disabled={props.disabled}
    title={runtime().generating ? '停止生成' : '发送'}
    aria-label={runtime().generating ? '停止生成' : '发送消息'}
    onClick={() => runtime().generating ? cancel() : send()}
  ><svg viewBox="0 0 24 24" class={iconClass()} aria-hidden="true"><path d={path()} /></svg></button>
}

export function SolidAttachWidget(props: { disabled?: boolean } = {}) {
  const workbench = useSolidWorkbench()
  const appearance = () => workbench.appearanceSnapshot()
  const runtime = () => workbench.runtimeSnapshot()
  const variant = () => appearance().attachVariant || 'icon'
  const className = () => variant() === 'minimal' ? 'cc-attach-minimal' : variant() === 'square' ? 'cc-attach-square' : 'cc-attach-icon'
  const scale = () => appearance().ccScale.attach ?? 100
  const title = () => !runtime().canAttach
    ? '附件暂不可用'
    : runtime().promptImage
      ? 'Attach file'
      : '当前 Agent 不支持图片（文本附件可用）'

  return (
    <button
      type="button"
      class={className()}
      style={{ 'font-size': `${scale()}%` }}
      disabled={props.disabled || (Boolean(workbench.input().sessionId) && !runtime().canAttach)}
      title={title()}
      aria-label={runtime().promptImage ? '添加附件' : '附件（当前 Agent 不支持图片）'}
      onClick={() => window.dispatchEvent(new CustomEvent('pylon:solid-input-attach'))}
    >＋</button>
  )
}
