import { Show, createMemo } from 'solid-js'
import temml from 'temml'

/**
 * #267：数学公式渲染——Temml（LaTeX→MathML），WebView2/Chromium 原生渲染
 * MathML，不携带任何字体资产（选型见 ADR-0021）。
 *
 * 失败路径：Temml `throwOnError:false` 时把错误渲染为 `temml-error` 节点而非抛出；
 * 异常兜底返回 null，回落 latex 原文。任何路径都不抛错、不阻塞渲染流。
 */
export function renderMathMarkup(latex: string, display: boolean): string | null {
  try {
    return temml.renderToString(latex, {
      displayMode: display,
      throwOnError: false,
      annotate: false,
    })
  } catch {
    return null
  }
}

export function MathRender(props: { latex: string; display: boolean }) {
  const markup = createMemo(() => renderMathMarkup(props.latex, props.display))
  return (
    <Show when={markup()} fallback={<span class="term-math-raw">{props.latex}</span>}>
      {resolved => props.display
        ? <div class="term-math term-math-display" innerHTML={resolved()} />
        : <span class="term-math term-math-inline" innerHTML={resolved()} />}
    </Show>
  )
}
