import { For, Show, createMemo } from 'solid-js'
import { stripAnsiControlSequences } from '../../../domains/rendererContent/textContentContracts.ts'

export interface SolidAnsiBlockProps {
  text: string
  reducedMotion?: boolean
  wrap?: 'soft' | 'none'
  maxLines?: number
  background?: string
  palette?: string
}

const SAFE_CSS_HEX = /^#[0-9a-f]{6}$/i

function safeCssHex(value: string | undefined): string | undefined {
  return value && SAFE_CSS_HEX.test(value) ? value : undefined
}

function safeBackground(value: string | undefined): string | undefined {
  return value === 'transparent' ? value : safeCssHex(value)
}

/**
 * C00：content.ansi 的 Solid surface。
 * - SGR 白名单着色（class-only，无 inline style）；OSC/控制序列已剥离；
 * - aria-label 暴露纯文本（辅助技术读到的是内容而非转义噪声）；
 * - 原始文本经 title 可访问，复制语义由外层消息 copy 承担。
 */
export function SolidAnsiBlock(props: SolidAnsiBlockProps) {
  const spans = createMemo(() => stripAnsiControlSequences(props.text))
  const plainText = () => spans().map(span => span.text).join('')

  return (
    <div
      class="term-ansi term-ansi-block"
      data-reduced-motion={props.reducedMotion ? 'true' : 'false'}
      data-wrap={props.wrap ?? 'soft'}
      data-palette={props.palette ?? 'terminal'}
      role="img"
      aria-label={plainText()}
      title={plainText()}
      style={{
        'white-space': props.wrap === 'none' ? 'pre' : 'pre-wrap',
        'max-height': `${props.maxLines ?? 800}em`,
        'overflow-y': 'auto',
        'background-color': safeBackground(props.background),
      }}
    >
      <For each={spans()}>{span => (
        <Show when={span.text} fallback={null}>
          {(() => {
            const classes: string[] = []
            if (span.fg) classes.push(`term-ansi-fg-${span.fg}`)
            if (span.bg) classes.push(`term-ansi-bg-${span.bg}`)
            if (span.bold) classes.push('term-ansi-bold')
            if (span.dim) classes.push('term-ansi-dim')
            if (span.italic) classes.push('term-ansi-italic')
            if (span.underline) classes.push('term-ansi-underline')
            const safeClasses = classes.filter(className => /^[a-z0-9-]+$/.test(className))
            return <span
              class={safeClasses.length > 0 ? safeClasses.join(' ') : undefined}
              style={{ color: safeCssHex(span.fgCss), 'background-color': safeCssHex(span.bgCss) }}
            >{span.text}</span>
          })()}
        </Show>
      )}</For>
    </div>
  )
}

export default SolidAnsiBlock
