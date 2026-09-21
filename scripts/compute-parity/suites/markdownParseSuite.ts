// markdown-parse 域套件：wasm `parseMarkdown`（comrak）vs 雕刻基线
// `parseMarkdownTs`（unified/remark 管线，76cbc819^ 原样解析核）。
// 已过审差异：脚注形状（remark-gfm 的 user-content-fn-* 锚点 vs comrak 脚注）。

import type { Suite } from '../harness.ts'
import { normalizeBoundaryMaps } from '../harness.ts'
import type { ComputeContextLike } from '../index.ts'
import { parseMarkdownTs } from '../baselines/oldMarkdownParsePipeline.ts'
import { MARKDOWN_EDGE_CORPUS, MARKDOWN_SHAPE_CORPUS, markdownScaleDoc } from '../fixtures/corpora.ts'

export function buildMarkdownParseSuite(ctx: ComputeContextLike): Suite {
  const wasm = ctx.markdown
  return {
    domain: 'markdown-parse',
    pairs: [
      {
        name: 'parseMarkdown',
        domain: 'markdown-parse',
        ts: text => parseMarkdownTs(text),
        wasm: text => normalizeBoundaryMaps(wasm.parseMarkdown(text)),
        knownDivergences: ['footnote-probe'],
        cases: [
          ...MARKDOWN_SHAPE_CORPUS.map(item => ({
            id: item.id,
            meta: { shape: 'blocks' as const },
            build: () => item.input,
          })),
          ...MARKDOWN_EDGE_CORPUS.map(item => ({
            id: item.id,
            meta: { shape: 'blocks' as const, edge: true },
            build: () => item.input,
          })),
          { id: 'doc-s', meta: { scale: 's' }, build: () => markdownScaleDoc(20) },
          { id: 'doc-m', meta: { scale: 'm' }, build: () => markdownScaleDoc(300) },
          { id: 'doc-l', meta: { scale: 'l' }, build: () => markdownScaleDoc(3000) },
        ],
      },
      {
        // **生产的流式形状**：`MarkdownContent.solid` 把文本切成「已完成块 stable + 增长尾块
        // unstable」，stable 走内容键 LRU 复用不重解析，**每帧只解析这一小段短尾**
        // （见该文件 23–24 行与 `trimRowStructuralWhitespace`）。
        //
        // 为什么单独列：整篇解析（上面的 doc-*）是**冷渲染/全量重解析**的形状，一次调用摊掉
        // 全部过界成本；流式短尾相反 —— 每帧一次调用、输入只有几十到上千字符，过界固定开销
        // 可能吃掉解析优势。两者的比值不通用，必须分开量。
        name: 'parseMarkdown(unstable-tail)',
        domain: 'markdown-parse',
        ts: text => parseMarkdownTs(text),
        wasm: text => normalizeBoundaryMaps(wasm.parseMarkdown(text)),
        cases: [
          { id: 'tail-20', meta: { scale: 'xs', shape: 'streaming-tail' }, build: () => tailOf(20) },
          { id: 'tail-80', meta: { scale: 'xs', shape: 'streaming-tail' }, build: () => tailOf(80) },
          { id: 'tail-320', meta: { scale: 's', shape: 'streaming-tail' }, build: () => tailOf(320) },
          { id: 'tail-1280', meta: { scale: 's', shape: 'streaming-tail' }, build: () => tailOf(1280) },
          // 带行内标记的短尾（`**粗**` / `` `code` `` / 链接）：真实尾块不是纯散文。
          {
            id: 'tail-inline-markers',
            meta: { scale: 's', shape: 'streaming-tail' },
            build: () => `${tailOf(160)}**粗体**与\`代码\`还有[链接](https://example.com/a)。`,
          },
        ],
      },
      {
        // 逐帧驱动：一段文字按固定步长增长，**每帧解析当前整条尾块**（生产里 graft 判据不成立
        // 时走的就是这条）。用来量「一次流式回合里 markdown 解析的累计成本」。
        //
        // `parseMarkdownTs` 是 **async**（unified 管线），所以这里必须 `Promise.all`：
        // 直接 `.map` 会得到一串 Promise，`stableJson` 把它们读成 `{}` —— 那是脚手架的错，
        // 不是计算分歧（这个坑本轮踩过一次，记在用例注释里）。
        name: 'parseMarkdown(growing-tail)',
        domain: 'markdown-parse',
        ts: frames => Promise.all(frames.map(frame => parseMarkdownTs(frame))),
        wasm: frames => frames.map(frame => normalizeBoundaryMaps(wasm.parseMarkdown(frame))),
        cases: [
          {
            id: 'growing-paragraph',
            meta: { scale: 's', flow: 'streaming-tail' },
            build: () => growingFrames(1280, 40),
          },
          {
            id: 'growing-paragraph-with-blocks',
            meta: { scale: 's', flow: 'streaming-tail' },
            build: () => growingFrames(2000, 50, true),
          },
        ],
      },
    ],
  }
}

/** 正在被输入的普通段落（CJK + ASCII，无 markdown 构造 ⇒ parity 两侧应逐字节一致）。 */
const UNSTABLE_TAIL_BASE =
  '这段文字正在被逐字输入，用于量每帧只解析短尾块这个生产形状的开销；' +
  'tail parse 的输入量级由它决定，而不是整篇文档的长度。'

const tailOf = (length: number): string =>
  UNSTABLE_TAIL_BASE.repeat(Math.ceil(length / UNSTABLE_TAIL_BASE.length) + 1).slice(0, length)

/** 按 `step` 字增长到 `total`，返回每一帧的尾块文本。`blocks` 时每 5 帧插一个换行（结构边界）。 */
const growingFrames = (total: number, step: number, blocks = false): string[] => {
  const frames: string[] = []
  for (let length = step; length <= total; length += step) {
    const raw = tailOf(length)
    frames.push(blocks ? `${raw.slice(0, raw.length - 1)}

` : raw)
  }
  return frames
}
