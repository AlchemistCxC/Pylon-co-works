// markdown-highlight 域基准：生产出口 `highlightBlock`（wasm，syntect）。
//
// 接线点：`src/components/chat/codeHighlight.ts:91`——`highlightCodeBuiltin` 的语言门通过后
// 调的就是它。**语言门之前的那截不在本读数内**（见下「没接线的两条」）。
//
// 语料在树上 `scripts/compute-parity/fixtures/corpora.ts`（HIGHLIGHT_CORPUS）；那条套件
// （`66671b92^:scripts/compute-parity/suites/markdownHighlightSuite.ts`）随 #220 下线 markdown
// 装置一起删除，被删的 TS 基线 `oldHighlightEngine.ts`（starry-night 雕刻）**不借**。
//
// 没接线的两条（按「没接线的不用了」排除）：
// - `scopeForLanguage` 的 **wasm 出口**：生产用的是 `codeHighlight.ts:15` 的 TS 映射表
//   （同步门，未知语言根本不过界），wasm 那个出口在 `src/` 里没有调用方。
// - `HIGHLIGHT_CORPUS` 里的 `unknown-language` case：生产在同步语言门就被挡住、不进计算核，
//   拿它当产品路径 case 会量到一条生产永不走的路径。

import type { MarkdownCompute } from '../../../src/infrastructure/compute/markdownCompute.ts'
import { loadMarkdownCompute } from '../../../src/infrastructure/compute/markdownCompute.ts'
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

export async function buildMarkdownHighlightSuite(): Promise<PerfSuite> {
  const compute: MarkdownCompute = await loadMarkdownCompute()
  const cases: PerfCase[] = [
    {
      // 单列成一行是为了让 ts 语法资产那笔**一次性**成本落在自己账上：计算核的线性内存高水位
      // 只涨不跌，首个调用会把它注册进去（实测数十 MB），不隔离的话会记到紧随其后的
      // `ts-sample` 头上。注意注册是**按语言懒加载**的——其余语言各自在首行显示 Δ（见 pair note）。
      id: 'engine-warmup',
      meta: { scale: 'xs', shape: 'warmup' },
      note: 'ts 语法资产注册（一次性）。没有工作量量纲，故不给单位成本。',
      run: () => { compute.highlightBlock('const x = 1\n', 'ts') },
    },
    ...HIGHLIGHT_CORPUS
      .filter(item => item.id !== 'unknown-language')
      .map(item => ({
        id: item.id,
        meta: { shape: item.language },
        units: item.code.length,
        unitLabel: '字符',
        run: () => { compute.highlightBlock(item.code, item.language) },
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
          run: () => { compute.highlightBlock(code, 'ts') },
        } satisfies PerfCase
      }),
  )

  return {
    domain: 'markdown-highlight',
    pairs: [
      {
        name: 'highlightBlock',
        domain: 'markdown-highlight',
        wiredAt: 'src/components/chat/codeHighlight.ts:91',
        note: '整块代码进、行数组出。这一列是**计算核那一段**：`codeHighlight.ts` 的结果缓存（128 条）、语言别名门、行数组拼 HTML 串与 #221 的视口降级/帧预算调度都不在其中。'
          + ' 另：「核线性Δ」列在**每种语言的第一行**会显示一次数 MB–数十 MB 的增量——那是 tmLanguage 语法资产按语言懒注册的一次性成本，不是该 case 的每调用占用。',
        cases,
      },
    ],
  }
}
