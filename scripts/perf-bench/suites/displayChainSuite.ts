// display-chain 域基准（#441/#449）：WorkbenchContent 每次发布（≤60/s，调度器上限）跑的
// 显示链——viewMessages 的 canonical 映射（toSolidMessage，WeakMap 复用）→ prepareMessages
// → buildMessageLookups → buildChatRowDescriptors → items per-key 复用（reuseMessageListItems）。
// 全链纯 TS，输入是已折好文档的 messages（走生产投影器折叠，见 fixtures/foldedDocuments.ts）。
//
// 不在读数里：viewMessages 的 legacy 过滤分支（生产恒空）、`WorkbenchContent` 组件内的
// Solid signal/memo 编排与 DOM 消费、`displayGateSignature` 显示门。
//
// 两个 pair 的分工：
// - `append-delta`：文本 delta 每拍换新 messages 数组（生产 applyLive 的形状）——全价读数；
// - `usage-only`：tool/usage 等事件不改 messages 引用（reduceTool 只换 activities+timeline），
//   #441-A 的引用门控落地后这条读数应趋近 0——**当前（门控前）与全价相同，此行即改前基线**。
import { chatRowDescriptorsOf } from '../../../src/domains/chat/chatRowPipeline.ts'
import { messageLookupsOf } from '../../../src/domains/chat/messageLookups.ts'
import { prepareMessagesOf } from '../../../src/domains/chat/messagePipeline.ts'
import type { Message } from '../../../src/domains/chat/messageTypes.ts'
import type { WorkbenchMessage } from '../../../src/domains/workbench/workbenchProjector.ts'
import { reuseMessageListItems, type MessageListItem } from '../../../src/domains/workbench/messageListPort.ts'
import { toSolidMessage } from '../../../src/renderers/solid-workbench/solidWorkbenchProjectionSupport.ts'
import { foldedWorkbenchDocument } from '../fixtures/foldedDocuments.ts'
import type { CaseMeta, PerfCase, PerfPair, PerfSuite } from '../harness.ts'

function chainCase(id: string, meta: CaseMeta, rows: number, mode: 'append-delta' | 'usage-only', note?: string): PerfCase {
  // 夹具惰性构造（同 projectorSuite.liveCase）：xs/s 档不为 l 档的 240k 事件折叠付费。
  let state: { readonly views: readonly [readonly WorkbenchMessage[], readonly WorkbenchMessage[]] } | undefined
  const ensure = () => {
    if (state === undefined) {
      const blocks = Math.ceil(rows / 2) + 1
      const base = foldedWorkbenchDocument(blocks).messages.slice(0, rows)
      if (mode === 'append-delta') {
        // 尾行两个变体交替（审查轮 P2：fixture 引用全稳会让 B 增量「零行重建」，低估生产
        // 尾部 delta 的成本）——真实 delta 每拍换尾行引用，失配段每拍重建。
        const prefix = base.slice(0, -1)
        const last = base[base.length - 1]!
        const tailA: WorkbenchMessage = { ...last, content: `${last.content}·` }
        const tailB: WorkbenchMessage = { ...last, content: `${last.content}‥` }
        state = { views: [[...prefix, tailA], [...prefix, tailB]] }
      } else {
        state = { views: [base, base] }
      }
    }
    return state
  }
  // usage-only 模拟「tool/usage 事件不改 messages 引用」：view 数组跨 run 复用，四个门
  // （prepare/lookups/descriptors/items）全部命中——读数即门控后的稳态成本。
  // append-delta 模拟「文本 delta 每拍换新 messages」：view 每拍新建 + 尾行引用在两变体间
  // 交替——四门全部失效、B 增量的失配段每拍重建，读数即全价。
  let frozenView: readonly Message[] | undefined
  let previousItems: readonly MessageListItem[] = []
  let runIndex = 0
  const view = (): readonly Message[] => {
    if (mode === 'usage-only') {
      frozenView ??= ensure().views[0].map(toSolidMessage)
      return frozenView
    }
    return ensure().views[runIndex % 2].map(toSolidMessage)
  }
  return {
    id,
    meta,
    units: rows,
    unitLabel: '行',
    ...(note !== undefined ? { note } : {}),
    run: () => {
      const current = view()
      const prepared = prepareMessagesOf(current)
      const descriptors = chatRowDescriptorsOf(prepared, messageLookupsOf(current), undefined)
      previousItems = reuseMessageListItems(previousItems, descriptors)
      runIndex += 1
    },
  }
}

export function buildDisplayChainSuite(): PerfSuite {
  const pair = (name: string, mode: 'append-delta' | 'usage-only', wiredNote: string): PerfPair => ({
    name,
    domain: 'display-chain',
    wiredAt: 'src/renderers/solid-workbench/WorkbenchContent.solid.tsx:177-233',
    minUnitsForUnitCost: 256,
    note: wiredNote,
    cases: [
      chainCase('rows-xs', { scale: 'xs' }, 100, mode),
      chainCase('rows-s', { scale: 's' }, 1_000, mode),
      chainCase('rows-m', { scale: 'm' }, 10_000, mode),
      chainCase('rows-l', { scale: 'l' }, 40_000, mode, '40k 行档：冻结指针扫描读数（#204③）所用的同量级会话。'),
    ],
  })
  return {
    domain: 'display-chain',
    pairs: [
      pair('displayChain(append-delta)', 'append-delta', '每发布全链一拍（messages 引用已换新、尾行在两变体间交替，四道引用门全失效）——全价读数。链走生产门控缝 prepareMessagesOf/messageLookupsOf/chatRowDescriptorsOf/reuseMessageListItems；toSolidMessage/prepareMessages 命中 WeakMap 复用。'),
      pair('displayChain(usage-only)', 'usage-only', '同一输入重复喂（tool/usage 事件不改 messages 引用，四道引用门全命中）——#441-A 门控后的稳态读数。'),
    ],
  }
}
