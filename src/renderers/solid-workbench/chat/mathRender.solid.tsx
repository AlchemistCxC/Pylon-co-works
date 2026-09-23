import { Show, createMemo } from 'solid-js'
import temml from 'temml'

/**
 * #267：数学公式渲染——Temml（LaTeX→MathML），WebView2/Chromium 原生渲染
 * MathML，不携带任何字体资产（选型见 ADR-0021）。
 *
 * 失败路径：Temml `throwOnError:false` 时把错误渲染为 `temml-error` 节点而非抛出；
 * 异常兜底返回 null，回落 latex 原文。任何路径都不抛错、不阻塞渲染流。
 *
 * 性能守卫（#267 验收追问）：Temml 单次渲染实测短式 ~0.01ms、Basel 显示式
 * ~0.03ms、2K 字符病态式 ~0.6ms，但流式尾块逐 tick 重解析与 #243 行虚拟化
 * 滚回视口重挂载都会对**同一 latex 重复渲染**。渲染是纯函数，按
 * `display\0latex` 键做有界 FIFO 缓存（形态沿用 renderModelCache 的首键淘汰）
 * ——重复渲染退化为一次 Map 查找，失败（null）结果同样入缓存不重试。
 */
const MATH_MARKUP_CACHE_LIMIT = 1024
const mathMarkupCache = new Map<string, string>()

export function renderMathMarkup(latex: string, display: boolean): string | null {
  const key = `${display ? 'd' : 'i'}\u0000${latex}`
  const cached = mathMarkupCache.get(key)
  if (cached !== undefined) return cached
  let markup: string | null = null
  try {
    markup = temml.renderToString(latex, {
      displayMode: display,
      throwOnError: false,
      annotate: false,
    })
  } catch {
    markup = null
  }
  if (mathMarkupCache.size >= MATH_MARKUP_CACHE_LIMIT) {
    const oldest = mathMarkupCache.keys().next().value
    if (oldest !== undefined) mathMarkupCache.delete(oldest)
  }
  mathMarkupCache.set(key, markup)
  return markup
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
