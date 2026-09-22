// markdown-parse 域基准：生产出口 `parseMarkdown`（wasm，comrak）。
//
// 接线点：`src/renderers/solid-workbench/chat/markdownRenderModel.ts:7,494`——渲染模型
// 就是这个出口的调用方（LRU / graft / 最新即胜这些宿主侧编排不在本读数内，见文件末注释）。
//
// case 面从 git 历史恢复：`66671b92^:scripts/compute-parity/suites/markdownParseSuite.ts`
// 的**输入构造方式**与「生产流式形状」的取舍理由（该套件随 #220 下线 markdown 装置一起删除，
// 被删的是 TS 基线 `oldMarkdownParsePipeline.ts`——那不借）。语料仍在树上
// `scripts/compute-parity/fixtures/corpora.ts`。

import type { MarkdownCompute } from '../../../src/infrastructure/compute/markdownCompute.ts'
import { loadMarkdownCompute } from '../../../src/infrastructure/compute/markdownCompute.ts'
import { MARKDOWN_EDGE_CORPUS, MARKDOWN_SHAPE_CORPUS, markdownScaleDoc } from '../../compute-parity/fixtures/corpora.ts'
import type { CaseMeta, PerfCase, PerfPair, PerfSuite } from '../harness.ts'

/**
 * 正在被输入的普通段落（CJK + ASCII，无 markdown 构造）。短尾解析的输入量级由它决定，
 * 而不是整篇文档的长度——生产里每帧只解析这一小段。
 */
const UNSTABLE_TAIL_BASE =
  '这段文字正在被逐字输入，用于量每帧只解析短尾块这个生产形状的开销；'
  + 'tail parse 的输入量级由它决定，而不是整篇文档的长度。'

const tailOf = (length: number): string =>
  UNSTABLE_TAIL_BASE.repeat(Math.ceil(length / UNSTABLE_TAIL_BASE.length) + 1).slice(0, length)

/** 按 `step` 字增长到 `total`，返回每一帧的尾块文本。`blocks` 时每帧末尾补一个换行（结构边界）。 */
const growingFrames = (total: number, step: number, blocks = false): string[] => {
  const frames: string[] = []
  for (let length = step; length <= total; length += step) {
    const raw = tailOf(length)
    frames.push(blocks ? `${raw.slice(0, raw.length - 1)}\n\n` : raw)
  }
  return frames
}

const textCase = (compute: MarkdownCompute) => (id: string, meta: CaseMeta, text: string, note?: string): PerfCase => ({
  id,
  meta,
  units: text.length,
  unitLabel: '字符',
  ...(note ? { note } : {}),
  run: () => { compute.parseMarkdown(text) },
})

/** 逐帧序列：一次计时把整段增长过程跑完，工作量是各帧文本长度之和。 */
const framesCase = (compute: MarkdownCompute) => (id: string, meta: CaseMeta, frames: readonly string[], note?: string): PerfCase => ({
  id,
  meta,
  units: frames.reduce((total, frame) => total + frame.length, 0),
  unitLabel: '字符',
  ...(note ? { note } : {}),
  run: () => { for (const frame of frames) compute.parseMarkdown(frame) },
})

/**
 * 把形状语料放大到可测规模。
 *
 * 为什么不是原样用 `MARKDOWN_SHAPE_CORPUS` 的 20–60 字符输入：那个量级读到的是一次调用的
 * 固定开销（过界 + 编组），单位成本会算出 `13.41µs/字符` 这类噪声——老对照跑器正是在这批
 * 输入上把噪声当比值印出来（本 issue 要废除的形状之一）。这里保留**形状**（同一份语料重复
 * 成同形状的长文档），把规模提到单位成本有意义的量级；逐条契约形状由 parity 门禁负责。
 */
function scaleShape(input: string, chars = 4_096): string {
  const unit = input.length > 0 ? input : '\n'
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)
}

export async function buildMarkdownParseSuite(): Promise<PerfSuite> {
  const compute = await loadMarkdownCompute()
  const one = textCase(compute)
  const many = framesCase(compute)

  return {
    domain: 'markdown-parse',
    pairs: [
      {
        name: 'parseMarkdown',
        domain: 'markdown-parse',
        wiredAt: 'src/renderers/solid-workbench/chat/markdownRenderModel.ts:7,494',
        note: '整块 markdown 进、渲染模型出。这一列是**计算核那一段**：宿主侧的 LRU（2,000,000 字符预算）、graft 增量拼接与「最新即胜」跳过都不在其中。'
          + ' 形状语料（heading-paragraph / table / …）由 `scaleShape` 放大到 ~4k 字符：原样 20–60 字符的输入只会读到一次调用的固定开销，单位成本是噪声。'
          + ' 边角语料（empty / crlf / …）保持原样——那里要看的是「边界不炸」，工作量不足门槛故不给单位成本。',
        cases: [
          // 放大到 ~4k 字符 ≈ `doc-s`（4240 字符）的量级，故 scale 记为 s 而不是 xs——scale 是
          // 输入量级的标签，不是「语料原始大小」的标签；标错会让 PERF_SCALE 过滤失真。
          ...MARKDOWN_SHAPE_CORPUS.map(item => one(item.id, { scale: 's', shape: item.id }, scaleShape(item.input))),
          ...MARKDOWN_EDGE_CORPUS.map(item => one(item.id, { shape: 'edge', edge: true }, item.input)),
          one('doc-s', { scale: 's', shape: 'doc' }, markdownScaleDoc(20)),
          one('doc-m', { scale: 'm', shape: 'doc' }, markdownScaleDoc(300)),
          one('doc-l', { scale: 'l', shape: 'doc' }, markdownScaleDoc(3000)),
        ],
      },
      {
        // **生产的流式形状**：`MarkdownContent.solid` 把文本切成「已完成块 stable + 增长尾块
        // unstable」，stable 走内容键 LRU 复用不重解析，**每帧只解析这一小段短尾**。
        //
        // 为什么单独列：整篇解析（上面的 doc-*）是**冷渲染/全量重解析**的形状，一次调用摊掉
        // 全部过界成本；流式短尾相反——每帧一次调用、输入只有几十到上千字符，过界固定开销
        // 可能吃掉解析优势。两者的单位成本不通用，必须分开量。
        name: 'parseMarkdown(unstable-tail)',
        domain: 'markdown-parse',
        wiredAt: 'src/renderers/solid-workbench/chat/MarkdownContent.solid.tsx:85',
        note: '尾块的每帧解析成本；`framesCase` 之外的短尾 case 都是单次调用，单位成本可比。',
        cases: [
          one('tail-20', { scale: 'xs', shape: 'streaming-tail' }, tailOf(20)),
          one('tail-80', { scale: 'xs', shape: 'streaming-tail' }, tailOf(80)),
          one('tail-320', { scale: 's', shape: 'streaming-tail' }, tailOf(320)),
          one('tail-1280', { scale: 's', shape: 'streaming-tail' }, tailOf(1280)),
          // 带行内标记的短尾（`**粗**` / `` `code` `` / 链接）：真实尾块不是纯散文。
          one('tail-inline-markers', { scale: 's', shape: 'streaming-tail' },
            `${tailOf(160)}**粗体**与\`代码\`还有[链接](https://example.com/a)。`),
        ],
      },
      {
        // 逐帧驱动：一段文字按固定步长增长，**每帧解析当前整条尾块**（生产里 graft 判据不成立
        // 时走的就是这条）。量的是「一次流式回合里 markdown 解析的累计成本」——#208 的
        // 「同一批内容被反复解析约一个数量级」正是这条形状的量级来源。
        name: 'parseMarkdown(growing-tail)',
        domain: 'markdown-parse',
        wiredAt: 'src/renderers/solid-workbench/chat/markdownRenderModel.ts:250,283',
        note: '整段重解析那一半（graft 判据不成立时的回退路径）。graft 命中那一半有模块级基座状态、没有只读 reset 出口，本轮不单列（见开发记录「未解问题」）。',
        cases: [
          many('growing-paragraph', { scale: 's', flow: 'growing' }, growingFrames(1280, 40),
            '纯散文增长：graft 判据的「顺利路径」，用于界定回退路径的上界。'),
          many('growing-paragraph-with-blocks', { scale: 's', flow: 'growing' }, growingFrames(2000, 50, true),
            '带块边界的增长：每帧末尾补空行，反复切开/合并尾块。'),
        ],
      },
    ],
  }
}
