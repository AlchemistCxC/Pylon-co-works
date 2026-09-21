// streaming-split 域套件：四个切分出口（stable/unstable、stableBlocks、
// 块边界偏移、未闭合围栏尾块）。TS 侧 = 冻结基线 oldStreamingMarkdownSplit.ts。

import type { Suite } from '../harness.ts'
import type { ComputeContextLike } from '../index.ts'
import {
  findLastStableBlockBoundary as tsFindLastStableBlockBoundary,
  splitOpenCodeFenceTail as tsSplitOpenCodeFenceTail,
  splitStreamingMarkdown as tsSplitStreamingMarkdown,
  splitStreamingMarkdownBlocks as tsSplitStreamingMarkdownBlocks,
} from '../baselines/oldStreamingMarkdownSplit.ts'
import { PREFIX_SCAN_SOURCE, repeatedBlocks, SPLIT_CORPUS } from '../fixtures/corpora.ts'

export function buildStreamingSplitSuite(ctx: ComputeContextLike): Suite {
  const wasm = ctx.compute
  return {
    domain: 'streaming-split',
    pairs: [
      {
        name: 'splitStreamingMarkdown',
        domain: 'streaming-split',
        ts: text => tsSplitStreamingMarkdown(text),
        wasm: text => wasm.splitStreamingMarkdown(text),
        cases: [
          ...SPLIT_CORPUS.map((text, index) => ({
            id: `corpus-${index}`,
            meta: { shape: 'corpus' as const, edge: text.length === 0 },
            build: () => text,
          })),
          { id: 'prefix-scan-source', meta: { scale: 's', flow: 'prefix-scan' }, build: () => PREFIX_SCAN_SOURCE },
          { id: 'blocks-s', meta: { scale: 's' }, build: () => repeatedBlocks(20) },
          { id: 'blocks-m', meta: { scale: 'm' }, build: () => repeatedBlocks(500) },
          { id: 'blocks-l', meta: { scale: 'l' }, build: () => repeatedBlocks(5000) },
        ],
      },
      {
        // flow=prefix-scan：切分决策只依赖完整行，**每个前缀**都必须两侧一致
        //（与 streamingComputeParity 的全前缀扫描同口径）。已知差异：chunk 边界
        // 劈开 UTF-16 代理对时（前缀以孤立高代理结尾），Rust 字符串无法持有该
        // 半个 emoji，serde 编组落成 U+FFFD；TS 字符串原样保留孤立代理。这是
        // UTF-8/UTF-16 编组层的固有损耗，不是切分逻辑分歧。
        name: 'splitStreamingMarkdown(prefix-scan)',
        domain: 'streaming-split',
        ts: source => prefixScanSplits(tsSplitStreamingMarkdown, source),
        wasm: source => prefixScanSplits(text => wasm.splitStreamingMarkdown(text), source),
        knownDivergences: ['growing-source'],
        cases: [
          { id: 'growing-source', meta: { scale: 's', flow: 'prefix-scan' }, build: () => PREFIX_SCAN_SOURCE },
        ],
      },
      {
        name: 'splitStreamingMarkdownBlocks',
        domain: 'streaming-split',
        ts: text => tsSplitStreamingMarkdownBlocks(text),
        wasm: text => wasm.splitStreamingMarkdownBlocks(text),
        cases: [
          ...SPLIT_CORPUS.map((text, index) => ({
            id: `corpus-${index}`,
            meta: { shape: 'corpus' as const, edge: text.length === 0 },
            build: () => text,
          })),
          { id: 'prefix-scan', meta: { scale: 's', flow: 'prefix-scan' }, build: () => PREFIX_SCAN_SOURCE },
          { id: 'blocks-m', meta: { scale: 'm' }, build: () => repeatedBlocks(500) },
        ],
      },
      {
        name: 'findLastStableBlockBoundary',
        domain: 'streaming-split',
        ts: text => tsFindLastStableBlockBoundary(text),
        wasm: text => wasm.findLastStableBlockBoundary(text),
        cases: [
          ...SPLIT_CORPUS.map((text, index) => ({
            id: `corpus-${index}`,
            meta: { shape: 'corpus' as const, edge: text.length === 0 },
            build: () => text,
          })),
          { id: 'blocks-m', meta: { scale: 'm' }, build: () => repeatedBlocks(500) },
        ],
      },
      {
        name: 'splitOpenCodeFenceTail',
        domain: 'streaming-split',
        ts: text => tsSplitOpenCodeFenceTail(text),
        wasm: text => wasm.splitOpenCodeFenceTail(text),
        cases: [
          ...SPLIT_CORPUS.filter(text => text.includes('```')).map((text, index) => ({
            id: `fence-corpus-${index}`,
            meta: { shape: 'corpus' as const, edge: text.length === 0 },
            build: () => text,
          })),
          { id: 'unclosed-rust-fence', meta: { shape: 'fence', edge: true }, build: () => '前文\n\n```rust\nfn main() {\n    let x = 1;' },
          { id: 'closed-fence', meta: { shape: 'fence' }, build: () => '```js\nconst a = 1\n```\n后文' },
          { id: 'no-fence', meta: { shape: 'fence', edge: true }, build: () => '没有任何围栏的普通文本' },
        ],
      },
    ],
  }
}

/** 前缀扫描专用：把源文本按「逐字符簇增长」生成全部前缀的切分结果序列。 */
export function prefixScanSplits(
  split: (text: string) => { stable: string, unstable: string },
  source: string,
): Array<{ at: number, stable: string, unstable: string }> {
  const out: Array<{ at: number, stable: string, unstable: string }> = []
  for (let at = 1; at <= source.length; at += 1) {
    const result = split(source.slice(0, at))
    out.push({ at, stable: result.stable, unstable: result.unstable })
  }
  return out
}
