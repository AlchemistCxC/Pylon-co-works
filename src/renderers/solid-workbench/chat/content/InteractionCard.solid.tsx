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
  // 主链 semantic command type 是 'interaction.respond'（Slot gate 映射到 interactionResponse capability 位）
  const canRespond = () => pending() && props.commands?.canExecute?.('interaction.respond') === true

  const respond = (payload: Record<string, unknown>) => {
    void props.commands?.execute({
      type: 'interaction.respond',
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
      <Show when={request().kind === 'sudo' && (request() as Record<string, unknown>).command}>
        {/* C12：sudo 显示命令/原因，不记录密码 */}
        <div class="interaction-terminal-state">
          <code>{String((request() as Record<string, unknown>).command)}</code>
          <Show when={(request() as Record<string, unknown>).reason}>
            {reason => <span>原因：{String(reason())}</span>}
          </Show>
        </div>
      </Show>
      <Show when={request().kind === 'oauth' && (request() as Record<string, unknown>).url}>
        {/* C12：OAuth URL 只读呈现；open 动作经 resource.open capability gate */}
        <div class="interaction-terminal-state">
          <code>{String((request() as Record<string, unknown>).url)}</code>
          <Show when={canRespond() && props.commands?.canExecute?.('resource.open') === true}>
            <button type="button" class="term-file-action" tabindex="0"
              onClick={() => { void props.commands?.execute({ type: 'resource.open', targetId: props.interaction.id,
                payload: { uri: (request() as Record<string, unknown>).url } }) }}>
              打开授权页
            </button>
          </Show>
        </div>
      </Show>
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
        </div>
      </Show>
    </section>
  )
}

export default SolidInteractionCard
