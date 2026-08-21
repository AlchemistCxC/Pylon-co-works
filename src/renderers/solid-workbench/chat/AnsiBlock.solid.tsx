import { For, Show, createMemo } from 'solid-js'
import { stripAnsiControlSequences } from '../../../domains/rendererContent/textContentContracts.ts'

export interface SolidAnsiBlockProps {
  text: string
  reducedMotion?: boolean
}

const CSS_HEX_CLASS = /^term-ansi-(?:fgc|bgc)-[0-9a-f]{3,6}$/

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
      class="term-ansi-block"
      data-reduced-motion={props.reducedMotion ? 'true' : 'false'}
      role="img"
      aria-label={plainText()}
      title={plainText()}
    >
      <For each={spans()}>{span => (
        <Show when={span.text} fallback={null}>
          {(() => {
            const classes: string[] = []
            if (span.fg) classes.push(`term-ansi-fg-${span.fg}`)
            else if (span.fgCss) classes.push(`term-ansi-fgc-${span.fgCss.slice(1)}`)
            if (span.bg) classes.push(`term-ansi-bg-${span.bg}`)
            else if (span.bgCss) classes.push(`term-ansi-bgc-${span.bgCss.slice(1)}`)
            if (span.bold) classes.push('term-ansi-bold')
            if (span.dim) classes.push('term-ansi-dim')
            if (span.italic) classes.push('term-ansi-italic')
            if (span.underline) classes.push('term-ansi-underline')
            const safeClasses = classes.filter(className => /^[a-z0-9-]+$/.test(className))
            void CSS_HEX_CLASS
            return safeClasses.length > 0
              ? <span class={safeClasses.join(' ')}>{span.text}</span>
              : <span>{span.text}</span>
          })()}
        </Show>
      )}</For>
    </div>
  )
}

export default SolidAnsiBlock
