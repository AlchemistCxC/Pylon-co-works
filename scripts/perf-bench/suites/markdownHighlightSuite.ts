// markdown-highlight 域基准：**引擎出口** `highlightBlockWithLezer`（Lezer，纯 JS）。
//
// 接线点：`src/components/chat/codeHighlight.ts:76`——`highlightCodeBuiltin` 的语言门通过后
// 调的就是它。**语言门与它外面那层编排不在本读数内**（见 pair note）。
//
// #241/ADR-0020 起高亮引擎不再是 wasm（syntect），而是前端 Lezer；本域因此**不再触 wasm**：
// 「核线性Δ」列恒为 0 是预期（旧引擎在这里会显示每语言数 MB–数十 MB 的、不可归还的线性内存台阶）。
//
// 语料在树上 `scripts/compute-parity/fixtures/corpora.ts`（HIGHLIGHT_CORPUS）。
//
// 一条不在本域内：`HIGHLIGHT_CORPUS` 里的 `unknown-language` case——生产在同步语言门就被挡住、
// 不进引擎，拿它当产品路径 case 会量到一条生产永不走的路径。

import { highlightBlockWithLezer } from '../../../src/components/chat/lezerHighlight.ts'
import { HIGHLIGHT_CORPUS } from '../../compute-parity/fixtures/corpora.ts'
import type { PerfCase, PerfSuite } from '../harness.ts'

/** 合成的大块 TS 源码（巨块形状：记录 221 实测 300 行巨块、#208 实测 372 行代码块）。 */
function largeCodeBlock(chars: number): string {
  const unit = [
    'export function sample(list: readonly string[]): number {',
    '  const mapped = list.map(item => item.length)',
    '  return mapped.reduce((a, b) => a + b, 0)',
    '}',
    '',
  ].join('\n')
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)
}

export function buildMarkdownHighlightSuite(): PerfSuite {
  const cases: PerfCase[] = [
    {
      // 单列成一行：隔离「Lezer 引擎与语言包」的一次性装载（动态 import + 该语言的 parser 初始化）。
      // 旧引擎这一行是「tmLanguage 编译进不可归还的线性内存」（数十 MB）；现在只是 JS 侧装载。
      id: 'engine-warmup',
      meta: { scale: 'xs', shape: 'warmup' },
      note: 'Lezer 引擎 + ts 语言包的一次性装载。没有工作量量纲，故不给单位成本。',
      run: () => highlightBlockWithLezer('const x = 1\n', 'ts'),
    },
    ...HIGHLIGHT_CORPUS
      .filter(item => item.id !== 'unknown-language')
      .map(item => ({
        id: item.id,
        meta: { shape: item.language },
        units: item.code.length,
        unitLabel: '字符',
        run: () => highlightBlockWithLezer(item.code, item.language),
      })),
  ]

  cases.push(
    ...([['block-4k', 's', 4_000], ['block-40k', 'm', 40_000], ['block-200k', 'l', 200_000]] as const)
      .map(([id, scale, chars]) => {
        // 输入在计时循环**之外**构造一次：`run` 里现造会把生成字符串的成本算进高亮成本。
        const code = largeCodeBlock(chars)
        return {
          id,
          meta: { scale, shape: 'large' },
          units: code.length,
          unitLabel: '字符',
          ...(id === 'block-40k'
            ? { note: '巨块：高亮成本随代码长度线性膨胀，而这块 DOM 在 #221 之前是整块常驻的。' }
            : {}),
          run: () => highlightBlockWithLezer(code, 'ts'),
        } satisfies PerfCase
      }),
  )

  return {
    domain: 'markdown-highlight',
    pairs: [
      {
        name: 'highlightBlockWithLezer',
        domain: 'markdown-highlight',
        wiredAt: 'src/components/chat/codeHighlight.ts:76',
        note: '整块代码进、行数组出。这一列是**引擎那一段**：`codeHighlight.ts` 的同步语言门、'
          + '结果缓存（128 条）与并发去重、行数组拼 HTML 串，以及 #221 的视口降级/帧预算调度都不在其中。'
          + ' 另：本域**不触 wasm**，「核线性Δ」列恒为 0 是预期（旧 syntect 引擎在每种语言首行会显示数 MB–数十 MB 的不可归还增量）。',
        cases,
      },
    ],
  }
}
