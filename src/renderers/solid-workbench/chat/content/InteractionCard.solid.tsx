import { For, Show, createMemo, createSignal } from 'solid-js'
import type { RenderAppearanceSnapshot, RenderCommandPort } from '../../../../contracts/messageRenderer.ts'
import type { WorkbenchInteraction } from '../../../../domains/workbench/workbenchProjector.ts'

/**
 * C11：审批 / 问题 / 确认 / 权限交互卡（Solid）。
 *
 * 卡面规则：
 * - 只读 normalized request（kind/prompt/options/danger/capability/expiry），不读 vendor payload；
 * - response 必须经 command port 携带 interactionId；resolved/expired 呈现终态，不再可提交；
 * - danger 交互默认焦点不落在危险确认按钮上（按钮 tabIndex 后置 + 提示文案）。
 */

interface NormalizedRequest {
  kind?: string
  prompt?: string
  danger?: boolean
  capability?: string
  expiry?: string
  reason?: string
  scope?: string
  command?: string
  path?: string
  provider?: string
  url?: string
  urlRedacted?: boolean
  stateSummary?: string
  status?: string
  timeoutMs?: number
  options?: { id: string; label: string; danger?: boolean; description?: string }[]
  questions?: NormalizedQuestion[]
}

interface NormalizedQuestion {
  id: string
  question: string
  options: { id: string; label: string; danger?: boolean; description?: string }[]
  allowMultiple: boolean
  allowFreeform: boolean
  placeholder?: string
}

/** C11：从 normalized request 收窄卡面字段；非 object 静默降级为纯文本 prompt。 */
function parseRequest(raw: unknown): NormalizedRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const record = raw as Record<string, unknown>
  const identity = typeof record.identity === 'object' && record.identity !== null && !Array.isArray(record.identity)
    ? record.identity as Record<string, unknown>
    : undefined
  const provider = typeof record.provider === 'string'
    ? record.provider
    : typeof identity?.provider === 'string' ? identity.provider : undefined
  const questions = Array.isArray(record.questions)
    ? record.questions.flatMap((value): NormalizedQuestion[] => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
      const question = value as Record<string, unknown>
      if (typeof question.id !== 'string' || typeof question.question !== 'string') return []
      const options = Array.isArray(question.options)
        ? question.options.filter((optionValue): optionValue is { id: string; label: string; danger?: boolean; description?: string } => {
          if (typeof optionValue !== 'object' || optionValue === null || Array.isArray(optionValue)) return false
          const option = optionValue as Record<string, unknown>
          return typeof option.id === 'string' && typeof option.label === 'string'
        })
        : []
      return [{
        id: question.id,
        question: question.question,
        options,
        allowMultiple: question.allowMultiple === true,
        allowFreeform: question.allowFreeform === true,
        placeholder: typeof question.placeholder === 'string' ? question.placeholder : undefined,
      }]
    })
    : []
  const firstQuestion = questions[0]
  if (!firstQuestion) return { ...record, ...(provider ? { provider } : {}) } as NormalizedRequest
  return {
    ...record as NormalizedRequest,
    ...(provider ? { provider } : {}),
    prompt: firstQuestion.question || (typeof record.title === 'string' ? record.title : undefined),
    options: firstQuestion.options,
    questions,
  }
}

export function SolidInteractionCard(props: {
  interaction: WorkbenchInteraction
  appearance?: RenderAppearanceSnapshot
  commands?: RenderCommandPort
}) {
  let cardElement: HTMLElement | undefined
  const request = createMemo(() => parseRequest(props.interaction.request))
  const appearanceValue = (key: string) => props.appearance?.[key]
  const presentation = () => appearanceValue('presentation') === 'modal' ? 'modal' : 'inline'
  const optionDensity = () => appearanceValue('optionDensity') === 'compact' ? 'compact' : 'comfortable'
  const maxWidth = () => typeof appearanceValue('maxWidth') === 'number' ? `${appearanceValue('maxWidth')}px` : undefined
  const showDescriptions = () => appearanceValue('descriptionsExpanded') !== false
  const showTechnicalMetadata = () => appearanceValue('showTechnicalMetadata') === true
  const showProviderMetadata = () => appearanceValue('showProviderMetadata') !== false
  const countdownStyle = () => appearanceValue('countdownStyle') === 'hidden'
    ? 'hidden'
    : appearanceValue('countdownStyle') === 'detailed' ? 'detailed' : 'compact'
  const statusColor = () => {
    const key = props.interaction.status === 'resolved'
      ? 'resolvedColor'
      : props.interaction.status === 'expired' ? 'expiredColor' : 'pendingColor'
    const value = appearanceValue(key)
    return typeof value === 'string' ? value : undefined
  }
  const orderedOptions = () => {
    const options = request().options ?? []
    if (appearanceValue('confirmOrder') !== 'safe-first') return options
    return options.map((option, index) => ({ option, index }))
      .sort((left, right) => Number(left.option.danger === true) - Number(right.option.danger === true) || left.index - right.index)
      .map(entry => entry.option)
  }
  const pending = () => props.interaction.status === 'requested'
  const terminalLabel = () => {
    const response = props.interaction.response
    if (response && typeof response === 'object' && !Array.isArray(response)
      && (response as Record<string, unknown>).cancelled === true) return '已取消'
    if (props.interaction.status === 'expired' && /timeout|超时/i.test(props.interaction.reason ?? '')) return '已超时'
    return props.interaction.status === 'resolved' ? '已响应' : '已过期'
  }
  // 主链 semantic command type 是 'interaction.respond'（Slot gate 映射到 interactionResponse capability 位）
  const canRespond = () => pending() && props.commands?.canExecute?.('interaction.respond') === true

  // A09 步骤4/C11 步骤4：失败恢复——CommandResult.ok=false 时保留输入并呈现错误，不误标已响应
  const [submitError, setSubmitError] = createSignal<string | undefined>(undefined)
  const [submitting, setSubmitting] = createSignal(false)
  const [selected, setSelected] = createSignal<Record<string, string[]>>({})
  const [freeform, setFreeform] = createSignal<Record<string, string>>({})
  const respond = async (payload: Record<string, unknown>) => {
    if (!pending() || submitting()) return
    setSubmitting(true); setSubmitError(undefined)
    try {
      await props.commands?.execute({
        type: 'interaction.respond',
        targetId: props.interaction.id,
        payload: { ...payload, expectedRevision: props.interaction.sequence },
      })
    } catch (error) {
      setSubmitError(request().kind === 'secret' ? '凭据提交失败，请重试' : error instanceof Error ? error.message : '交互提交失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  const toneClass = () => `interaction-card interaction-${request().kind ?? 'generic'}`
    + (request().danger ? ' interaction-danger' : '')
  const usesQuestionForm = () => {
    const questions = request().questions ?? []
    return questions.length > 1 || questions.some(question => question.allowMultiple || (question.allowFreeform && question.options.length > 0))
  }

  const selectOption = (question: NormalizedQuestion, optionId: string) => {
    setSelected(current => {
      const previous = current[question.id] ?? []
      const next = question.allowMultiple
        ? previous.includes(optionId) ? previous.filter(id => id !== optionId) : [...previous, optionId]
        : [optionId]
      return { ...current, [question.id]: next }
    })
  }
  const submitQuestions = () => {
    const values = Object.fromEntries((request().questions ?? []).flatMap(question => {
      const optionIds = selected()[question.id] ?? []
      const text = freeform()[question.id]?.trim()
      const answers = text ? [...optionIds, text] : optionIds
      if (answers.length === 0) return []
      return [[question.id, question.allowMultiple || answers.length > 1 ? answers : answers[0]!]]
    }))
    if (Object.keys(values).length > 0) void respond({ values })
  }
  const trapModalFocus = (event: KeyboardEvent) => {
    if (presentation() !== 'modal' || event.key !== 'Tab' || !cardElement) return
    const focusable = [...cardElement.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter(element => !element.hasAttribute('disabled'))
    if (focusable.length === 0) return
    const first = focusable[0]!
    const last = focusable.at(-1)!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus()
    }
  }

  return (
    <section
      ref={cardElement}
      class={toneClass()}
      data-interaction-id={props.interaction.id}
      data-interaction-status={props.interaction.status}
      role={presentation() === 'modal' ? 'dialog' : 'status'}
      aria-modal={presentation() === 'modal' ? 'true' : undefined}
      aria-label={`交互：${request().prompt ?? props.interaction.id}，${props.interaction.status}`}
      data-presentation={presentation()}
      data-option-density={optionDensity()}
      data-countdown-style={countdownStyle()}
      onKeyDown={trapModalFocus}
      style={{
        'max-width': maxWidth(),
        '--interaction-danger-color': typeof appearanceValue('dangerColor') === 'string' ? appearanceValue('dangerColor') as string : undefined,
        '--interaction-warning-color': typeof appearanceValue('warningColor') === 'string' ? appearanceValue('warningColor') as string : undefined,
        '--interaction-status-color': statusColor(),
      }}
    >
      <header class="interaction-head">
        <strong>{request().prompt ?? props.interaction.id}</strong>
        <Show when={request().kind}>
          <span class="interaction-kind">{request().kind}</span>
        </Show>
        <Show when={request().capability}>
          <span class="interaction-capability">能力：{request().capability}</span>
        </Show>
        <Show when={showProviderMetadata() && request().provider}>
          {provider => <span class="interaction-capability">Provider：{provider()}</span>}
        </Show>
        <Show when={showTechnicalMetadata() && (request() as Record<string, unknown>).identity}>
          <small class="interaction-technical-metadata">
            {String(((request() as Record<string, unknown>).identity as Record<string, unknown>).requestId ?? '')}
          </small>
        </Show>
      </header>
      <Show when={request().kind !== 'sudo' && (request().reason || request().scope || request().command || request().path)}>
        <div class="interaction-terminal-state interaction-danger-context">
          <Show when={request().reason}>{reason => <span>原因：{reason()}</span>}</Show>
          <Show when={request().scope}>{scope => <span>范围：{scope()}</span>}</Show>
          <Show when={request().command}>{command => <code>{command()}</code>}</Show>
          <Show when={request().path}>{path => <code>{path()}</code>}</Show>
        </div>
      </Show>
      <Show when={request().kind === 'sudo' && (request() as Record<string, unknown>).command}>
        {/* C12：sudo 显示命令/原因，不记录密码 */}
        <div class="interaction-terminal-state">
          <code>{String((request() as Record<string, unknown>).command)}</code>
          <Show when={(request() as Record<string, unknown>).reason}>
            {reason => <span>原因：{String(reason())}</span>}
          </Show>
          <Show when={request().scope}>{scope => <span>范围：{scope()}</span>}</Show>
          <Show when={request().timeoutMs !== undefined && countdownStyle() !== 'hidden'}>
            <span>超时：{countdownStyle() === 'detailed'
              ? `${Math.max(0, Math.round(request().timeoutMs! / 1000))} 秒（提交后开始计时）`
              : `${Math.max(0, Math.round(request().timeoutMs! / 1000))}s`}</span>
          </Show>
        </div>
      </Show>
      <Show when={request().kind === 'oauth'}>
        {/* C12：OAuth URL 只读呈现；open 动作经 resource.open capability gate */}
        <div class="interaction-terminal-state">
          <Show when={request().stateSummary}>{summary => <span>{summary()}</span>}</Show>
          <Show when={request().status}>{status => <span>状态：{status()}</span>}</Show>
          <Show when={request().url} fallback={request().urlRedacted ? <span>链接已隐藏</span> : undefined}>
            {url => <code>{url()}</code>}
          </Show>
          <Show when={request().url && canRespond() && props.commands?.canExecute?.('resource.open') === true}>
            <button type="button" class="term-file-action" tabindex="0"
              onClick={() => { void props.commands?.execute({ type: 'resource.open', targetId: props.interaction.id,
                payload: { uri: request().url } }) }}>
              打开授权页
            </button>
          </Show>
          <Show when={request().url && canRespond() && props.commands?.canExecute?.('clipboard.write') === true}>
            <button type="button" class="term-file-action" tabindex="0"
              onClick={() => { void props.commands?.execute({
                type: 'clipboard.write', targetId: props.interaction.id,
                payload: { text: request().url },
              }) }}>
              复制授权链接
            </button>
          </Show>
        </div>
      </Show>
      <Show when={request().expiry}>
        <span class="interaction-expiry">截止：{request().expiry}</span>
      </Show>
      <Show when={pending()} fallback={
        <div class="interaction-terminal-state">
          <span>{terminalLabel()}</span>
          <Show when={request().kind !== 'secret' ? props.interaction.response : undefined}>
            {response => <code class="interaction-response">{JSON.stringify(response())}</code>}
          </Show>
          <Show when={props.interaction.reason}>
            {reason => <span>{reason()}</span>}
          </Show>
        </div>
      }>
        <Show when={usesQuestionForm()} fallback={<div class="interaction-options" role="group" aria-label="可选项">
          <For each={orderedOptions()}>
            {option => (
              <>
              <button
                type="button"
                class="term-file-action"
                // 危险选项不参与默认焦点链首位（Tab 顺序后置）
                tabindex={option.danger ? 2 : 0}
                disabled={!canRespond()}
                title={!canRespond()
                  ? '交互响应能力未接入或会话不可用'
                  : option.danger ? '危险操作：请确认后再选择' : undefined}
                onClick={() => respond({ optionId: option.id })}
              >
                {option.label ?? option.id}
              </button>
              <Show when={option.description}>
                {description => <details class="interaction-option-description" open={showDescriptions()}><summary>说明</summary><span>{description()}</span></details>}
              </Show>
              </>
            )}
          </For>
          <Show when={canRespond() && !request().options?.length}>
            <Show when={request().kind === 'secret'} fallback={
              <input
                type="text"
                class="interaction-free-text"
                placeholder="输入回答后回车"
                onKeyDown={event => {
                  if (event.key === 'Enter' && event.currentTarget.value.trim()) {
                    respond({ text: event.currentTarget.value.trim() })
                  }
                }}
              />
            }>
              {/* C12：secret 用 password input——禁止明文回显；提交后立即清空本地输入值 */}
              <input
                type="password"
                class="interaction-free-text"
                autocomplete="off"
                placeholder="输入后回车提交（不会显示或记录）"
                onKeyDown={event => {
                  if (event.key === 'Enter' && event.currentTarget.value) {
                    respond({ value: event.currentTarget.value })
                    event.currentTarget.value = ''
                  }
                }}
              />
            </Show>
          </Show>
          <Show when={submitError()}>
            {error => <div role="alert" class="term-process-error">{error()}</div>}
          </Show>
        </div>}>
          <form class="interaction-options" onSubmit={event => { event.preventDefault(); submitQuestions() }}>
            <For each={request().questions ?? []}>{question => (
              <fieldset class="interaction-question">
                <legend>{question.question}</legend>
                <For each={question.options}>{option => (
                  <label>
                    <input
                      type={question.allowMultiple ? 'checkbox' : 'radio'}
                      name={`interaction-${props.interaction.id}-${question.id}`}
                      value={option.id}
                      checked={(selected()[question.id] ?? []).includes(option.id)}
                      disabled={!canRespond()}
                      onChange={() => selectOption(question, option.id)}
                    />
                    {option.label}
                  </label>
                )}</For>
                <Show when={question.allowFreeform}>
                  <input
                    type="text"
                    class="interaction-free-text"
                    placeholder={question.placeholder ?? '补充回答'}
                    value={freeform()[question.id] ?? ''}
                    disabled={!canRespond()}
                    onInput={event => setFreeform(current => ({ ...current, [question.id]: event.currentTarget.value }))}
                  />
                </Show>
              </fieldset>
            )}</For>
            <button type="submit" class="term-file-action" disabled={!canRespond() || submitting()}>提交回答</button>
            <Show when={submitError()}>
              {error => <div role="alert" class="term-process-error">{error()}</div>}
            </Show>
          </form>
        </Show>
      </Show>
    </section>
  )
}

export default SolidInteractionCard
