import { createMemo } from 'solid-js'
import { renderMathMarkup } from './mathMarkup.ts'

/**
 * #267：数学公式渲染——Temml（LaTeX→MathML），WebView2/Chromium 原生渲染
 * MathML，不携带任何字体资产（选型见 ADR-0021）。
 *
 * 失败路径：Temml `throwOnError:false` 时把错误渲染为 `temml-error` 节点而非抛出；
 * 异常兜底返回 null，回落 latex 原文。任何路径都不抛错、不阻塞渲染流。
 *
 * renderMathMarkup（纯函数 + 缓存）在 ./mathMarkup.ts——独立 .ts 使 node 测试
 * 与主 tsconfig 检查不会把本组件文件拖进 React JSX 语义（#271 CI 修复）。
 */
export { renderMathMarkup }

export function MathRender(props: { latex: string; display: boolean }) {
  const markup = createMemo(() => renderMathMarkup(props.latex, props.display))
  // 失败（null）回落 latex 原文；不使用 <Show>——其泛型不接受 string|null，
  // 会连锁触发 React JSX 兜底类型误报（tsc -b 主 tsconfig 无 solid JSX 类型）。
  const fallback = <span class="term-math-raw">{props.latex}</span>
  return props.display
    ? markup() === null
      ? fallback
      : <div class="term-math term-math-display" innerHTML={markup() ?? ''} />
    : markup() === null
      ? fallback
      : <span class="term-math term-math-inline" innerHTML={markup() ?? ''} />
}
