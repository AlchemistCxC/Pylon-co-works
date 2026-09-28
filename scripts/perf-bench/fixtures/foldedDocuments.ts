// 共享的大文档夹具（#449）：display-chain 域与 projector 域的 `reduceWorkbenchEvent(live)`
// 都要「已折好的 N 行文档」——按 blocks 数 memo 化，两个套件共享同一份折好的文档，
// 避免各自把 240k 事件的大 journal 重折一遍（构造成本不进计时，但没必要付两次）。
//
// 语料用 `mixedJournal`（全族事件）：每 block 落 ~2 条 message 行（user + assistant），
// reasoning 因共享 messageId 折成单行——这是长会话 message 行的真实构成。
import { projectWorkbench, type WorkbenchDocument } from '../../../src/domains/workbench/workbenchProjector.ts'
import { mixedJournal } from './envelopes.ts'

const cache = new Map<number, WorkbenchDocument>()

export function foldedWorkbenchDocument(blocks: number): WorkbenchDocument {
  const cached = cache.get(blocks)
  if (cached) return cached
  const document = projectWorkbench(mixedJournal(blocks)).document
  cache.set(blocks, document)
  return document
}

/** 各档共用的一组 blocks（display-chain 的行数 ≈ 2×blocks；live 域直接用整份文档）。 */
export const FOLDED_BLOCKS_BY_SCALE = { xs: 51, s: 501, m: 5_001, l: 20_001 } as const
