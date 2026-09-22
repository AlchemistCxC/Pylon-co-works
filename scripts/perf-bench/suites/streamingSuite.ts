// streaming 域基准：**只取已接线的两个生产出口**，case 定义直接复用 parity 脚手架的套件。
//
// 为什么能复用：`buildStreamingSplitSuite` / `buildStreamingBudgetSuite` 里每个 pair 的
// `wasm` 侧就是生产出口本身（`streamingCompute()` 的薄壳转发，见
// `src/infrastructure/compute/streamingCompute.ts`），所以 `pair.wasm(case.build())` 恰好是
// 「产品路径一次调用」。这样语料与场景只有一份，改语料两边同时生效。
//
// 为什么只取四个 pair（另三个 wasm 出口**没接线**）：
// - `splitStreamingMarkdown` / `splitStreamingMarkdownBlocks` / `findLastStableBlockBoundary`
//   在 `src/` 里只被 parity 测试引用（生产消费方早已切到 ends 出口，
//   `src/renderers/solid-workbench/chat/MarkdownContent.solid.tsx:85`）。它们是**给 parity
//   门禁留的兼容出口**，不进本基准——这正是「没接线的不用了」。
// - parity **门禁**仍需要它们（覆盖门要求全部出口有对照 pair），所以那边一套不动。

import type { ComputeContextLike } from '../../compute-parity/index.ts'
import { buildStreamingBudgetSuite } from '../../compute-parity/suites/streamingBudgetSuite.ts'
import { buildStreamingSplitSuite } from '../../compute-parity/suites/streamingSplitSuite.ts'
import type { CaseMeta, PerfCase, PerfPair, PerfSuite } from '../harness.ts'

/**
 * 生产已接线的 pair 白名单（名字与 parity 套件一致），值是该路径的接线点。
 * 白名单制而不是黑名单：新增 wasm 出口时**默认不进基准**，要被显式接线并显式登记。
 */
const WIRED_PAIRS: Readonly<Record<string, { domain: PerfPair['domain'], at: string }>> = {
  'splitStreamingMarkdownBlockEnds': { domain: 'streaming-split', at: 'src/renderers/solid-workbench/chat/MarkdownContent.solid.tsx:85' },
  'splitOpenCodeFenceTail': { domain: 'streaming-split', at: 'src/renderers/solid-workbench/chat/MarkdownContent.solid.tsx:193' },
  'StreamingRevealEngine(replay)': { domain: 'streaming-reveal', at: 'src/renderers/solid-workbench/streamingDisplayScheduler.ts:4' },
  'StreamingRevealEngine(options)': { domain: 'streaming-reveal', at: 'src/renderers/solid-workbench/streamingDisplayScheduler.ts:4' },
}

const PAIR_NOTE: Readonly<Record<string, string>> = {
  splitStreamingMarkdownBlockEnds: '热路径：`MarkdownContent` 每拍拿块结束偏移，再从自己持有的文本切片（#220 边界收口把整组块字符串过界换成了 u32 数组）。',
  splitOpenCodeFenceTail: '每拍决定尾块是否走代码路径。整块围栏体越大，这条的成本越可见。',
  'StreamingRevealEngine(replay)': '输入是驱动脚本（reset/feed/noteBacklog/tick），一次计时完整回放一遍；工作量按 tick 数计。',
  'StreamingRevealEngine(options)': '同上，另带节奏选项；构造函数会做 positiveFinite/floor/max 归一化。',
}

/** 额外 case：不在 parity 套件里、但属已接线路径的真实形状（`input` 预构造好，直接喂同一个生产出口）。 */
interface ExtraCase {
  readonly id: string
  readonly meta: CaseMeta
  readonly input: unknown
  readonly units: number
  readonly unitLabel: string
  readonly note?: string
}

/** 前缀扫描的工作量是 Σ|prefix| = L(L+1)/2，不是 L——按 L 计会把单位成本放大两个数量级。 */
function splitUnits(caseId: string, text: string): number {
  const length = text.length
  return caseId.includes('prefix-scan') ? (length * (length + 1)) / 2 : length
}

/** 揭示脚本的拍数（工作量量纲）。两种输入形状：裸 Op[] 与 `{ script, options }`。 */
function tickCount(input: unknown): number {
  const script = Array.isArray(input) ? input : (input as { script?: unknown } | null)?.script
  if (!Array.isArray(script)) return 0
  return script.filter(step => (step as { op?: unknown } | null)?.op === 'tick').length
}

/** 长围栏体（未闭合）：记录 220 S4 量过「每帧免掉整份复制」的那条形状，这里纳入常规基准。 */
function fenceBody(bodyChars: number): string {
  return `前文段落\n\n\`\`\`rust\n${'let x = 1;\n'.repeat(Math.ceil(bodyChars / 10))}`
}

/** 长围栏体（已闭合后接下文）：生产里闭合围栏会走另一条分支。 */
function closedFenceDoc(bodyChars: number): string {
  return `前文段落\n\n\`\`\`ts\n${'const x = 1\n'.repeat(Math.ceil(bodyChars / 12))}\`\`\`\n\n后文段落继续。\n`
}

/** 无围栏的长散文：验证「没有尾围栏」这条快速路径的成本。 */
function proseDoc(chars: number): string {
  return '普通段落文本，没有围栏构造。\n\n'.repeat(Math.ceil(chars / 18)).slice(0, chars)
}

/**
 * 含列表的文档：**列表之后的块永远不稳定**。
 *
 * 这不是构造问题，是切分器（`pylon-compute` 的 `stable_block_byte_ends`）的保守规则——本机实测：
 *
 * | 输入 | 稳定块数 |
 * | --- | --- |
 * | `段落A\n\n段落B\n\n段落C` | 2（A、B 稳定，C 是尾块） |
 * | `段落A\n\n- 项1\n\n段落B` | **1**（只有 A） |
 * | `段落A\n\n> 引用\n\n段落B` | **1**（只有 A） |
 * | `- 项1\n- 项2\n\n新段落开始\n\n` | **0** |
 *
 * 即：列表/引用之后（含其后的普通段落、标题、分隔线）**一律不再产生稳定块**，整段落进同一条
 * 不稳定尾块。⇒ 生产里消息一旦含列表或引用，其后全部内容每拍都在尾块里被重新解析/重渲。
 * 这是 #208 观察到的「同一批内容被反复解析约一个数量级」的机制之一，故单列成本行。
 */
function listBlockDoc(chars: number): string {
  const head = '- 项1\n- 项2\n\n'
  const body = '列表之后的普通段落，本该自成一个稳定块。\n\n'
  return head + body.repeat(Math.ceil(chars / body.length))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

type ParityPair = {
  readonly name: string
  readonly cases: ReadonlyArray<{ readonly id: string, readonly meta: CaseMeta, readonly build: () => unknown }>
  readonly wasm: (input: never) => unknown
}

function toPerfCase(
  wasm: ParityPair['wasm'],
  scenario: { id: string, meta: CaseMeta },
  input: unknown,
  extraUnits?: { units: number, unitLabel: string },
): PerfCase {
  const isScript = Array.isArray(input) || (isRecord(input) && 'script' in input)
  const units = extraUnits?.units ?? (isScript ? tickCount(input) : splitUnits(scenario.id, String(input)))
  const unitLabel = extraUnits?.unitLabel ?? (isScript ? '拍' : '字符')
  return {
    id: scenario.id,
    meta: scenario.meta,
    units,
    unitLabel,
    run: () => wasm(input as never) as void | Promise<void>,
  }
}

/** 把 parity 套件的一个 pair 投影成基准 pair（只取 wasm 侧 + 工作量量纲）。 */
function projectPair(
  parityPair: ParityPair,
  options: { keep?: (caseId: string) => boolean, extras?: readonly ExtraCase[] } = {},
): PerfPair {
  const wired = WIRED_PAIRS[parityPair.name]!
  const kept = options.keep ? parityPair.cases.filter(scenario => options.keep!(scenario.id)) : parityPair.cases
  return {
    name: parityPair.name,
    domain: wired.domain,
    wiredAt: wired.at,
    ...(PAIR_NOTE[parityPair.name] ? { note: PAIR_NOTE[parityPair.name] } : {}),
    cases: [
      ...kept.map((scenario) => toPerfCase(parityPair.wasm, scenario, scenario.build())),
      ...(options.extras ?? []).map(extra => toPerfCase(
        parityPair.wasm,
        { id: extra.id, meta: extra.meta },
        extra.input,
        { units: extra.units, unitLabel: extra.unitLabel },
      )),
    ],
  }
}

export function buildStreamingSuites(ctx: ComputeContextLike): PerfSuite[] {
  const all: ParityPair[] = [
    ...buildStreamingSplitSuite(ctx).pairs,
    ...buildStreamingBudgetSuite(ctx).pairs,
  ] as unknown as ParityPair[]
  const pick = (
    name: string,
    options: { keep?: (caseId: string) => boolean, extras?: readonly ExtraCase[] } = {},
  ): PerfPair => projectPair(all.find(pair => pair.name === name)!, options)

  return [
    {
      domain: 'streaming-split',
      pairs: [
        pick('splitStreamingMarkdownBlockEnds', {
          // 丢掉 `corpus-*`（1–36 字符的契约边角）与 `splitStreamingMarkdownBlocks` 那套：
          // 契约边角由 parity 门禁负责，性能面要的是规模。保留 prefix-scan（O(L²) 的增长扫描）
          // 与 blocks-s/m/l（自终止的混合块形）。
          keep: caseId => caseId === 'prefix-scan' || caseId.startsWith('blocks-'),
          extras: [
            {
              id: 'list-block-m',
              meta: { scale: 'm', shape: 'list-poison' },
              input: listBlockDoc(8_000),
              units: 8_000,
              unitLabel: '字符',
              note: '列表毒化稳定块（实测表见 listBlockDoc）。对照读法：本行与 `blocks-m` 的每字符成本相差一个数量级'
                + '（0.6ns vs 11ns）——**切分成本 ∝ 稳定块数，不 ∝ 字符数**。'
                + '本行反而便宜，正因为这份 8k 文档只产出 1 个稳定块；代价不在切分这一拍，而在下游：'
                + '整段内容落进不稳定尾块 ⇒ 每拍都要整段重新解析（那笔由 `markdown-parse(growing-tail)` 量）。',
            },
            {
              id: 'list-block-l',
              meta: { scale: 'l', shape: 'list-poison' },
              input: listBlockDoc(64_000),
              units: 64_000,
              unitLabel: '字符',
            },
          ],
        }),
        pick('splitOpenCodeFenceTail', {
          // 同上：fence-corpus-* 与三条 30 字符的边角都不进性能面。
          keep: () => false,
          extras: [
            {
              id: 'fence-body-m',
              meta: { scale: 'm', shape: 'fence' },
              input: fenceBody(96_000),
              units: 96_000,
              unitLabel: '字符',
              note: '长围栏体（≈9.6 万字符、未闭合）：记录 220 S4 量过这条形状每帧免掉一次整份复制。',
            },
            {
              id: 'fence-body-l',
              meta: { scale: 'l', shape: 'fence' },
              input: fenceBody(480_000),
              units: 480_000,
              unitLabel: '字符',
            },
            {
              id: 'closed-fence-m',
              meta: { scale: 'm', shape: 'fence' },
              input: closedFenceDoc(96_000),
              units: 96_000,
              unitLabel: '字符',
              note: '已闭合的围栏（后面还有正文）：与未闭合走不同分支。',
            },
            {
              id: 'prose-m',
              meta: { scale: 'm', shape: 'prose' },
              input: proseDoc(96_000),
              units: 96_000,
              unitLabel: '字符',
              note: '无围栏散文：这条快速路径的成本基线，用来界定围栏扫描的净开销。',
            },
          ],
        }),
      ],
    },
    {
      domain: 'streaming-reveal',
      pairs: [pick('StreamingRevealEngine(replay)'), pick('StreamingRevealEngine(options)')],
    },
  ]
}
