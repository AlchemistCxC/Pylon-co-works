import { For, Show, createMemo } from 'solid-js'
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
  options?: { id: string; label: string; danger?: boolean }[]
}

/** C11：从 normalized request 收窄卡面字段；非 object 静默降级为纯文本 prompt。 */
function parseRequest(raw: unknown): NormalizedRequest {
  return (typeof raw === 'object' && raw !== null && !Array.isArray(raw))
    ? raw as NormalizedRequest
    : {}
}

export function SolidInteractionCard(props: {
  interaction: WorkbenchInteraction
  appearance?: RenderAppearanceSnapshot
  commands?: RenderCommandPort
}) {
  const request = createMemo(() => parseRequest(props.interaction.request))
  const pending = () => props.interaction.status === 'requested'
  const canRespond = () => pending() && props.commands?.canExecute?.('interactionResponse') === true

  const respond = (payload: Record<string, unknown>) => {
    void props.commands?.execute({
      type: 'interactionResponse',
      targetId: props.interaction.id,
      payload,
    })
  }

  const toneClass = () => `interaction-card interaction-${request().kind ?? 'generic'}`
    + (request().danger ? ' interaction-danger' : '')

  return (
    <section
      class={toneClass()}
      data-interaction-id={props.interaction.id}
      data-interaction-status={props.interaction.status}
      role="status"
      aria-label={`交互：${request().prompt ?? props.interaction.id}，${props.interaction.status}`}
    >
      <header class="interaction-head">
        <strong>{request().prompt ?? props.interaction.id}</strong>
        <Show when={request().kind}>
          <span class="interaction-kind">{request().kind}</span>
        </Show>
        <Show when={request().capability}>
          <span class="interaction-capability">能力：{request().capability}</span>
        </Show>
      </header>
      <Show when={request().expiry}>
        <span class="interaction-expiry">截止：{request().expiry}</span>
      </Show>
      <Show when={pending()} fallback={
        <div class="interaction-terminal-state">
          <span>{props.interaction.status === 'resolved' ? '已响应' : '已过期'}</span>
          <Show when={props.interaction.response}>
            {response => <code class="interaction-response">{JSON.stringify(response())}</code>}
          </Show>
          <Show when={props.interaction.reason}>
            {reason => <span>{reason()}</span>}
          </Show>
        </div>
      }>
        <div class="interaction-options" role="group" aria-label="可选项">
          <For each={request().options ?? []}>
            {option => (
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
            )}
          </For>
          <Show when={canRespond() && !request().options?.length}>
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
          </Show>
        </div>
      </Show>
    </section>
  )
}

export default SolidInteractionCard
