import { For, Show, createSignal } from 'solid-js'
import { useSolidWorkbench } from '../SolidWorkbenchContext.solid.tsx'

function nextValue(values: readonly string[], current: string): string {
  if (values.length === 0) return current
  const index = values.indexOf(current)
  return values[(index + 1 + values.length) % values.length] ?? values[0] ?? current
}

export function SolidModelWidget(props: { draftValue?: () => string; onDraftChange?: (value: string) => void; reasoningValue?: () => string; onReasoningChange?: (value: string) => void } = {}) {
  const workbench = useSolidWorkbench()
  const runtime = () => workbench.runtimeSnapshot()
  const appearance = () => workbench.appearanceSnapshot()
  const [open, setOpen] = createSignal(false)
  const [error, setError] = createSignal('')
  const models = () => runtime().availableModels.length > 0
    ? runtime().availableModels
    : ['deepseek-v4-flash', 'deepseek-v4-pro']
  const model = () => props.draftValue?.() || runtime().activeModel || models()[0] || '未配置模型'
  const displayModel = () => props.reasoningValue?.() ? `${model()}（${props.reasoningValue()}）` : model()
  const scale = () => appearance().ccScale.model ?? 100
  const choose = async (target: string) => {
    const sessionId = workbench.input().sessionId
    if (!sessionId && props.onDraftChange) { props.onDraftChange(target); setOpen(false); return }
    if (!sessionId || target === model()) return
    const result = await workbench.commands.setModel(sessionId, target)
    if (!result.ok) setError(result.error || '模型切换失败')
    else setError('')
    setOpen(false)
  }

  return (
    <div class="solid-model-widget">
      <Show when={error()}>{message => <span class="cc-widget-error" role="alert">{message()}</span>}</Show>
      <Show when={appearance().modelVariant === 'badge'} fallback={
        <Show when={appearance().modelVariant === 'minimal'} fallback={
          <div class="cc-model-dropdown">
            <button
              type="button"
              class="model-tag"
              style={{ 'font-size': `${scale()}%` }}
              aria-haspopup="listbox"
              aria-expanded={open()}
              onClick={() => setOpen(value => !value)}
            >{displayModel()} ▾</button>
            <Show when={open()}>
              <div class="model-menu" role="listbox" aria-label="模型列表">
                <Show when={props.reasoningValue && props.onReasoningChange}>
                  <div class="model-menu-section" aria-label="思考强度"><span>思考强度</span><For each={['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']}>{effort => <button type="button" role="option" aria-selected={effort === props.reasoningValue?.()} class={`model-item${effort === props.reasoningValue?.() ? ' active' : ''}`} onClick={() => props.onReasoningChange?.(effort)}>{effort}</button>}</For></div>
                </Show>
                <For each={models()}>{item => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={item === model()}
                    class={`model-item${item === model() ? ' active' : ''}`}
                    onClick={() => void choose(item)}
                  >{item}</button>
                )}</For>
              </div>
            </Show>
          </div>
        }>
          <button
            type="button"
            class="cc-model-minimal"
            title="点击切换模型"
            style={{ 'font-size': `${scale()}%` }}
            onClick={() => void choose(nextValue(models(), model()))}
          >{displayModel()}</button>
        </Show>
      }>
        <span class="cc-model-badge" style={{ 'font-size': `${scale()}%` }}>{displayModel()}</span>
      </Show>
    </div>
  )
}

export function SolidModeWidget(props: { draftValue?: () => string; onDraftChange?: (value: string) => void } = {}) {
  const workbench = useSolidWorkbench()
  const runtime = () => workbench.runtimeSnapshot()
  const appearance = () => workbench.appearanceSnapshot()
  const [error, setError] = createSignal('')
  const modes = () => runtime().availableModes.length > 0
    ? runtime().availableModes
    : ['default', 'edit', 'auto', 'bypass']
  const mode = () => props.draftValue?.() || runtime().activeMode || modes()[0] || 'default'
  const scale = () => appearance().ccScale.mode ?? 100
  const cycle = async () => {
    const sessionId = workbench.input().sessionId
    if (!sessionId && props.onDraftChange) { props.onDraftChange(nextValue(modes(), mode())); return }
    if (!sessionId) return
    const result = await workbench.commands.setMode(sessionId, nextValue(modes(), mode()))
    if (!result.ok) setError(result.error || '权限模式切换失败')
    else setError('')
  }

  return (
    <div class="solid-mode-widget">
      <Show when={error()}>{message => <span class="cc-widget-error" role="alert">{message()}</span>}</Show>
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

export function SolidSendWidget(props: { disabled?: boolean } = {}) {
  const workbench = useSolidWorkbench()
  const appearance = () => workbench.appearanceSnapshot()
  const runtime = () => workbench.runtimeSnapshot()
  const variant = () => appearance().sendVariant || 'icon'
  const className = () => variant() === 'minimal' ? 'cc-send-minimal' : variant() === 'square' ? 'cc-send-square' : 'cc-send-icon'
  const scale = () => appearance().ccScale.send ?? 100
  const send = () => window.dispatchEvent(new CustomEvent('pylon:solid-input-send'))
  const cancel = () => {
    const sessionId = workbench.input().sessionId
    if (sessionId) void workbench.commands.cancel(sessionId)
  }

  return (
    <button
      type="button"
      disabled={props.disabled}
      class={className()}
      style={{ 'font-size': `${scale()}%` }}
      title={runtime().generating ? '停止生成' : 'Send (Enter)'}
      aria-label={runtime().generating ? '停止生成' : '发送消息'}
      onClick={() => runtime().generating ? cancel() : send()}
    >{runtime().generating ? '■' : '↑'}</button>
  )
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
