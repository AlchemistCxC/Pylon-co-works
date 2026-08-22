import { Show, createResource, createSignal } from 'solid-js'
import { findOversizeFoldPoint } from '../../../domains/rendererContent/textContentContracts.ts'
import { highlightCode } from '../../../components/chat/codeHighlight.ts'

export interface SolidCodeBlockProps {
  code: string
  language?: string
  /** 超过此行数折叠（默认 400）；折叠后完整文本仍可复制 */
  maxLines?: number
  onCopy?: (text: string) => void
  showLanguage?: boolean
  showCopyButton?: boolean
  wrap?: 'soft' | 'none'
  palette?: string
}

/**
 * C00：content.code 的 Solid surface。
 * - 语言标签可见；未知语言回退 escaped plain text（高亮返回 null）；
 * - oversize 折叠在行边界，折叠提示明确，完整文本经 data-copy-text/onCopy 保留；
 * - copy 是显式用户动作，不自动执行。
 */
export function SolidCodeBlock(props: SolidCodeBlockProps) {
  const [copied, setCopied] = createSignal(false)
  let copiedTimer: number | undefined

  const fold = () => findOversizeFoldPoint(props.code, (props.maxLines ?? 400) * 8)
  const visibleCode = () => {
    const foldPoint = fold()
    return foldPoint ? props.code.slice(0, foldPoint.visibleLength) : props.code
  }
  const lines = () => visibleCode().split('\n')
  const isMultiLine = () => lines().length > 1
  const foldedCount = () => fold() ? props.code.split('\n').length - lines().length : 0

  const [highlighted] = createResource(
    () => isMultiLine() ? { language: props.language || 'text', code: visibleCode() } : undefined,
    input => highlightCode(input.language, input.code).catch(() => null),
  )
  const highlightedLines = () => highlighted()?.split('\n')

  const copy = () => {
    if (props.onCopy) props.onCopy(props.code)
    else void navigator.clipboard?.writeText(props.code).catch(() => {})
    setCopied(true)
    window.clearTimeout(copiedTimer)
    copiedTimer = window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div class="term-code-block" data-language={props.language ?? 'text'} data-folded={foldedCount() > 0 ? 'true' : 'false'} data-wrap={props.wrap ?? 'soft'} data-palette={props.palette ?? 'auto'}>
      <Show when={props.showLanguage !== false || props.showCopyButton !== false}>
        <div class="term-code-head">
          <Show when={props.showLanguage !== false}><span class="term-code-lang">{props.language ?? 'text'}</span></Show>
          <Show when={props.showCopyButton !== false}><button
            type="button"
            class="term-code-copy"
            aria-label={copied() ? '已复制' : '复制代码'}
            data-copy-text={props.code}
            onClick={copy}
          >{copied() ? '✓' : '⎘'}</button></Show>
        </div>
      </Show>
      <Show when={isMultiLine()} fallback={<code class="term-inline-code">{props.code}</code>}>
        <pre class="term-code-body" style={{ 'white-space': props.wrap === 'none' ? 'pre' : 'pre-wrap' }}><code>{lines().map((line, index) => (
          <span class="term-code-line">
            <span class="term-code-gutter" aria-hidden="true">│ </span>
            <Show
              when={highlightedLines()?.[index]}
              fallback={<span>{line || '\u00a0'}</span>}
            >
              {html => <span innerHTML={html()} />}
            </Show>
            {'\n'}
          </span>
        ))}</code></pre>
      </Show>
      <Show when={foldedCount() > 0}>
        <div class="term-code-folded" role="note">{`已折叠 ${foldedCount()} 行（复制获取全部内容）`}</div>
      </Show>
    </div>
  )
}

export default SolidCodeBlock
