import Anser from 'anser'
import { Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { sanitizeHtml } from '../../../components/chat/htmlSanitizer.ts'
import { resolveToolIndicatorAsset } from '../../../components/chat/toolIndicatorAssets.ts'
import { toolIndicatorMotionClass } from '../../../components/chat/toolIndicatorMotion.ts'
import {
  buildToolPresentationModel,
  truncateToolSummary,
  type ToolPresentationModel,
} from '../../../components/chat/toolPresentationModel.ts'
import type { Message } from '../../../components/chat/messageTypes.ts'
import { toolStatePresentation, type ToolVisualState } from '../../../domains/tool/status.ts'
import type { WorkbenchAppearanceSnapshot } from '../../../domains/workbench/appearance.ts'
import type { ToolConnectorLayoutPort } from '../../../domains/workbench/toolConnectorLayoutPort.ts'
import { measureToolAnchor } from './domToolConnectorMeasurement.ts'
import { SolidDiffCard } from './DiffCard.solid.tsx'
import { SolidCollapsibleRegion } from './CollapsibleRegion.solid.tsx'

export type ToolCardAppearance = Pick<WorkbenchAppearanceSnapshot,
  'toolIndicator' | 'toolIndicatorGlow' | 'toolIndicatorGlowColor'>

export interface SolidToolCardProps {
  message?: Message
  model?: ToolPresentationModel
  visualState?: ToolVisualState
  appearance: ToolCardAppearance
  messageId?: string
  layoutPort?: ToolConnectorLayoutPort
}

export function SolidToolCard(props: SolidToolCardProps) {
  let head: HTMLButtonElement | undefined
  let indicatorElement: HTMLSpanElement | undefined
  let observer: ResizeObserver | undefined
  const model = createMemo(() => props.model ?? (props.message
    ? buildToolPresentationModel(props.message, props.visualState)
    : null))
  const [open, setOpen] = createSignal(false)
  const bodyId = `solid-tool-${Math.random().toString(36).slice(2)}`

  onMount(() => {
    if (!props.layoutPort || !props.messageId) return
    const unregister = props.layoutPort.registerTool(
      props.messageId,
      () => measureToolAnchor(head, indicatorElement),
    )
    if (typeof ResizeObserver !== 'undefined' && head) {
      observer = new ResizeObserver(() => props.layoutPort?.invalidate('row-resized'))
      observer.observe(head)
    }
    onCleanup(() => {
      observer?.disconnect()
      unregister()
    })
  })

  return (
    <Show when={model()}>
      {resolved => {
        const status = () => toolStatePresentation(resolved().state, resolved().hasOutput).tone
        const indicator = () => resolveToolIndicatorAsset(props.appearance.toolIndicator)
        const displaySummary = () => truncateToolSummary(resolved().summary)
        const suffix = () => resolved().state === 'completed' && resolved().outputLines > 0
          ? ` — ${resolved().outputLabel}`
          : ''
        const glowStyle = () => props.appearance.toolIndicatorGlow > 0
          ? { textShadow: `0 0 ${props.appearance.toolIndicatorGlow}px ${props.appearance.toolIndicatorGlowColor || 'currentColor'}` }
          : undefined
        const outputHtml = () => resolved().kind === 'execute' && resolved().outputText
          ? sanitizeHtml(new Anser().ansiToHtml(Anser.escapeForHtml(resolved().outputText)))
          : ''

        return (
          <div
            class="term-tool"
            data-status={status()}
            data-tool-state={resolved().state}
            data-kind={resolved().kind}
            data-output-collapsible={resolved().canCollapseOutput ? 'true' : 'false'}
          >
            <button
              ref={head}
              class="term-tool-head"
              type="button"
              onClick={() => setOpen(value => !value)}
              aria-expanded={open()}
              aria-controls={bodyId}
            >
              <span
                ref={indicatorElement}
                class={`term-tool-indicator ${status()} ${toolIndicatorMotionClass(resolved().state)}`}
                style={glowStyle()}
                aria-label={indicator().ariaLabel[resolved().state]}
                role="img"
              >{indicator().glyph}</span>
              <span class="term-tool-name">{resolved().name}</span>
              <Show when={displaySummary()}>{summary => <span class="term-tool-summary"> ({summary()})</span>}</Show>
              <Show when={suffix()}>{text => <span class="term-tool-suffix">{text()}</span>}</Show>
            </button>
            <Show when={resolved().hasOutput}>
              <SolidCollapsibleRegion open={open()} id={bodyId}>
                <div class="term-tool-body">
                <span class={`term-tool-label${resolved().errorText ? ' term-tool-label-error' : ''}`}>
                  {resolved().errorText ? '错误' : '输出'}{resolved().outputLabel ? ` · ${resolved().outputLabel}` : ''}
                </span>
                <Show when={resolved().isDiffCandidate}>
                  <SolidDiffCard output={resolved().outputText} payload={resolved().diffPayload} />
                </Show>
                <Show
                  when={resolved().kind === 'execute' && outputHtml()}
                  fallback={<pre><code>{resolved().outputText}</code></pre>}
                >
                  {html => <div class="term-ansi" innerHTML={html()} />}
                </Show>
                </div>
              </SolidCollapsibleRegion>
            </Show>
          </div>
        )
      }}
    </Show>
  )
}
