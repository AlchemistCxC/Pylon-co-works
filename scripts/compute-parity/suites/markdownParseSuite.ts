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
    ],
  }
}
