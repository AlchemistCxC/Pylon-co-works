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
  palette?: string}

/**
 * C00：content.code 的 Solid surface。
 * - 语言标签可见；未知语言回退 escaped plain text（高亮返回 null）；
 * - oversize 折叠在行边界，折叠提示明确，完整文本经 data-copy-text/onCopy 保留；
 * - copy 是显式用户动作，不自动执行。
 */
export function SolidCodeBlock(props: SolidCodeBlockProps) {
  const [copied, setCopied] = createSignal(false)
  let copiedTimer: number | undefined

  // #208：默认折叠保留（超大块不默认全渲，这是它存在的理由），但折叠不再是死路——
  // 「复制获取全部内容」是唯一出口时，长思考/长回答在界面上被静默截断，用户读不到。
  // 现在按**有界步长**增量展开：每次点击新增 ≤ 一个预算（maxLines 行量级）且仍在行边界停。
  const maxLines = () => props.maxLines ?? 400
  const foldBudget = () => maxLines() * 8
  const baseFold = () => findOversizeFoldPoint(props.code, foldBudget())
  const [extraChars, setExtraChars] = createSignal(0)
  const visibleLength = () => {
    const base = baseFold()?.visibleLength
    if (base === undefined) return props.code.length
    return Math.min(props.code.length, base + extraChars())
  }
  const visibleCode = () => props.code.slice(0, visibleLength())
  const lines = () => visibleCode().split('\n')
  const isMultiLine = () => lines().length > 1
  const remainingLines = () => Math.max(0, props.code.split('\n').length - lines().length)
  const folded = () => remainingLines() > 0
  const nextStepLines = () => Math.min(maxLines(), remainingLines())
  const showMore = () => {
    const rest = props.code.slice(visibleLength())
    const step = findOversizeFoldPoint(rest, foldBudget())
    setExtraChars(current => current + (step ? step.visibleLength : rest.length))
  }
  const collapse = () => setExtraChars(0)

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
    <div class="term-code-block" data-language={props.language ?? 'text'} data-folded={folded() ? 'true' : 'false'} data-wrap={props.wrap ?? 'soft'} data-palette={props.palette ?? 'auto'}>
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
            {/* R-B1 契约：每行内容 span 都带 term-code-text（长行软折与缩进保留挂在它上面）。
                此前回退/高亮两条分支都没带这个类——流式块自带该类，所以缺口只暴露在 code 部件路径上。 */}
            <Show
              when={highlightedLines()?.[index]}
              fallback={<span class="term-code-text">{line || '\u00a0'}</span>}
            >
              {html => <span class="term-code-text" innerHTML={html()} />}
            </Show>
            {'\n'}
          </span>
        ))}</code></pre>
      </Show>
      <Show when={folded()}>
        <div class="term-code-folded flex items-center flex-wrap gap-2 text-2xs" role="note">
          <span>{`已折叠 ${remainingLines()} 行`}</span>
          <button
            type="button"
            class="term-code-folded-more cursor-pointer rounded-sm px-1 text-accent hover:bg-hover-bg"
            aria-expanded={folded() ? 'false' : 'true'}
            onClick={showMore}
          >{`显示更多 ${nextStepLines()} 行`}</button>
          <Show when={extraChars() > 0}>
            <button
              type="button"
              class="term-code-folded-less cursor-pointer rounded-sm px-1 text-content-muted hover:bg-hover-bg"
              onClick={collapse}
            >收起</button>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export default SolidCodeBlock
