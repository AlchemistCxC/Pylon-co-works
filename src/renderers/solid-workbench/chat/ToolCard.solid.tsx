import { Show, createMemo, onCleanup, onMount } from 'solid-js'
import { resolveToolIndicatorAssetForTone } from '../../../components/chat/toolIndicatorAssets.ts'
import { toolIndicatorMotionClass } from '../../../components/chat/toolIndicatorMotion.ts'
import {
  buildToolPresentationModel,
  capitalizeToolName,
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
import { createCollapsiblePresenter } from './CollapsiblePresenter.solid.tsx'
import { SolidAnsiBlock } from './AnsiBlock.solid.tsx'

export type ToolCardAppearance = Pick<WorkbenchAppearanceSnapshot,
  'toolIndicator' | 'toolIndicatorGlow' | 'toolIndicatorGlowColor'>
  & Partial<Pick<WorkbenchAppearanceSnapshot, 'toolIndicatorRun' | 'toolIndicatorOk' | 'toolIndicatorErr'>>

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
  const collapse = createCollapsiblePresenter({ defaultOpen: () => false, idPrefix: 'solid-tool' })

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
        const indicator = () => resolveToolIndicatorAssetForTone(status(), props.appearance)
        const displaySummary = () => truncateToolSummary(resolved().summary)
        const suffix = () => resolved().state === 'completed' && resolved().outputLines > 0
          ? ` — ${resolved().outputLabel}`
          : ''
        const glowStyle = () => props.appearance.toolIndicatorGlow > 0
          ? { textShadow: `0 0 ${props.appearance.toolIndicatorGlow}px ${props.appearance.toolIndicatorGlowColor || 'currentColor'}` }
          : undefined
        return (
          <div
            class="term-tool"
            data-status={status()}
            data-tool-state={resolved().state}
            data-status-label={toolStatePresentation(resolved().state, resolved().hasOutput).label}
            data-kind={resolved().kind}
            data-output-collapsible={resolved().canCollapseOutput ? 'true' : 'false'}
          >
            <button
              ref={head}
              class="term-tool-head"
              type="button"
              onClick={collapse.toggle}
              aria-expanded={collapse.open()}
              aria-controls={collapse.bodyId}
            >
              <span
                ref={indicatorElement}
                class={`term-tool-indicator ${status()} ${toolIndicatorMotionClass(resolved().state)}`}
                style={glowStyle()}
                aria-label={indicator().ariaLabel[resolved().state]}
                role="img"
              >{indicator().glyph}</span>
              <span class="term-tool-name">{capitalizeToolName(resolved().name)}</span>
              <Show when={displaySummary()}>{summary => <span class="term-tool-summary term-tool-summary-code"> ({summary()})</span>}</Show>
              <span class="term-tool-state-label"> — {toolStatePresentation(resolved().state, resolved().hasOutput).label}</span>
              <Show when={suffix()}>{text => <span class="term-tool-suffix">{text()}</span>}</Show>
            </button>
            <Show when={resolved().hasOutput}>
              <SolidCollapsibleRegion open={collapse.open()} id={collapse.bodyId}>
                <div class="term-tool-body">
                <span class={`term-tool-label${resolved().errorText ? ' term-tool-label-error' : ''}`}>
                  {resolved().errorText ? '错误' : '输出'}{resolved().outputLabel ? ` · ${resolved().outputLabel}` : ''}
                </span>
                <Show when={resolved().isDiffCandidate}>
                  <SolidDiffCard output={resolved().outputText} payload={resolved().diffPayload} />
                </Show>
                <Show
                  when={resolved().kind === 'execute' && resolved().outputText.length > 0}
                  fallback={<pre><code>{resolved().outputText}</code></pre>}
                >
                  <SolidAnsiBlock text={resolved().outputText} />
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
