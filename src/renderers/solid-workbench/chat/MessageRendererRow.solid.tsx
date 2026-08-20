import { Show, onCleanup } from 'solid-js'
import type { RenderMessage } from '../../../components/chat/messageTypes.ts'
import type { ToolVisualState } from '../../../domains/tool/status.ts'
import type { WorkbenchAppearanceSnapshot } from '../../../domains/workbench/appearance.ts'
import { SolidMessageRow } from './MessageRow.solid.tsx'
import { SolidToolCard } from './ToolCard.solid.tsx'

type RendererAppearance = Pick<WorkbenchAppearanceSnapshot,
  | 'userName' | 'userPrefix' | 'userColor'
  | 'assistantDot' | 'assistantDotGlyph' | 'assistantDotImage'
  | 'toolIndicator' | 'toolIndicatorGlow' | 'toolIndicatorGlowColor'>

export interface SolidMessageRendererRowProps {
  renderMessage: RenderMessage
  appearance: RendererAppearance
  highlighted?: boolean
  toolVisualState?: ToolVisualState
  rowRef?: (node: HTMLDivElement | null) => void
}

/** Semantic bridge used by the renderer engine; it never consumes a React component. */
export function SolidMessageRendererRow(props: SolidMessageRendererRowProps) {
  const tool = () => props.renderMessage.type === 'tool_call' || props.renderMessage.type === 'tool_result'
  onCleanup(() => props.rowRef?.(null))
  return (
    <Show
      when={tool()}
      fallback={<SolidMessageRow
        renderMessage={props.renderMessage}
        appearance={props.appearance}
        highlighted={props.highlighted}
        rowRef={props.rowRef}
      />}
    >
      <div
        ref={node => props.rowRef?.(node)}
        class={`term-row term-row-tool${props.highlighted ? ' term-row-search-active' : ''}`}
        data-render-type={props.renderMessage.type}
        data-pylon-component="message"
        data-message-role="tool"
      >
        <SolidToolCard
          message={props.renderMessage.message}
          visualState={props.toolVisualState}
          appearance={props.appearance}
          messageId={props.renderMessage.message.id}
        />
      </div>
    </Show>
  )
}
