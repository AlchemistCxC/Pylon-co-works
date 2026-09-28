// projector 域基准：生产活实现 `projectWorkbench`（TS，ADR-0018 修订 1 回退后的唯一实现）。
//
// 接线点：`src/domains/workbench/workbenchProjector.ts:444`；工作台会话在冷重放/刷新时调它。
// 输入面 `../fixtures/envelopes.ts` 从 git 历史恢复（出处见该文件头注）。
//
// 为什么这是「已接线」而不是「已回退所以不用量」：回退改的是**实现语言**，不是这条路径的存在。
// 投影每次冷重放都要跑，它的绝对成本与事件数成正比——正是最该有基准看着的那类开销点。

import { projectWorkbench, reduceWorkbenchEvent } from '../../../src/domains/workbench/workbenchProjector.ts'
import { coveragePage, deltaJournal, envelope, mixedJournal } from '../fixtures/envelopes.ts'
import { foldedWorkbenchDocument } from '../fixtures/foldedDocuments.ts'
import type { CaseMeta, PerfCase, PerfSuite } from '../harness.ts'

function foldCase(id: string, meta: CaseMeta, events: readonly unknown[], note?: string): PerfCase {
  return {
    id,
    meta,
    units: events.length,
    unitLabel: '事件',
    ...(note ? { note } : {}),
    // 批量回放入口按 sequence 归并后折叠；输入是 readonly 契约，不在 run 里重建
    // （重建会把语料构造成本算进投影成本）。
    run: () => { projectWorkbench(events as never) },
  }
}

/**
 * live 单事件续折（#440/#449）：前端 `applyLive` 的每帧路径——在**已折好的大文档**上
 * 逐事件 `reduceWorkbenchEvent`。一 run = 64 条 assistant 文本 delta 链折到同一 running
 * 行（真实流式形状：同一 messageId 逐拍追加）。基文档引用跨 run 不变 ⇒ 每 run 工作相同；
 * 读数含 messages/timeline 整表拷贝与 appliedRanges/appliedEventIds 的合并+冻结——
 * #440-b（冻结治理）的改前基线就在这一行。
 */
function liveCase(id: string, meta: CaseMeta, blocks: number, note?: string): PerfCase {
  // 夹具惰性构造：套件 build 阶段只登记参数，首次 run 才折基文档——xs/s 档不为 l 档的
  // 240k 事件折叠付构造成本（foldedWorkbenchDocument 内部 memo，跨 case/套件共享）。
  let prepared: { readonly base: ReturnType<typeof foldedWorkbenchDocument>, readonly deltas: ReturnType<typeof buildLiveDeltas> } | undefined
  const ensure = () => {
    if (prepared === undefined) {
      const base = foldedWorkbenchDocument(blocks)
      prepared = { base, deltas: buildLiveDeltas(base.revision) }
    }
    return prepared
  }
  return {
    id,
    meta,
    units: 64,
    unitLabel: '事件',
    ...(note ? { note } : {}),
    run: () => {
      const { base, deltas } = ensure()
      let document = base
      for (const delta of deltas) document = reduceWorkbenchEvent(document, delta)
    },
  }
}

function buildLiveDeltas(baseRevision: number) {
  return Array.from({ length: 64 }, (_, index) => envelope(
    baseRevision + index + 1,
    { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: `live-delta-${index}`.padEnd(24, 'x') }] },
    { messageId: 'live-perf' },
    { origin: 'local-observed', trust: 'authoritative' },
    [baseRevision + index + 1, baseRevision + index + 1],
  ))
}

export function buildProjectorSuite(): PerfSuite {
  return {
    domain: 'projector',
    pairs: [
      {
        name: 'projectWorkbench(fold)',
        domain: 'projector',
        wiredAt: 'src/domains/workbench/workbenchProjector.ts:444',
        note: '冷重放的一次性折叠成本（事件数 × 单事件归约成本）。这一列不含 DOM 与渲染层消费。',
        cases: [
          foldCase('delta-xs', { scale: 'xs', flow: 'cold' }, deltaJournal(1)),
          foldCase('delta-s', { scale: 's', flow: 'cold' }, deltaJournal(100)),
          foldCase('delta-m', { scale: 'm', flow: 'cold' }, deltaJournal(2_000)),
          foldCase('delta-l', { scale: 'l', flow: 'cold' }, deltaJournal(20_000),
            '单向 delta 流（单文本部件、零 JSON 通道）：纯热路径。'),
          foldCase('mixed-xs', { scale: 'xs', shape: 'mixed-flow', flow: 'cold' }, mixedJournal(1)),
          foldCase('mixed-s', { scale: 's', shape: 'mixed-flow', flow: 'cold' }, mixedJournal(10)),
          foldCase('mixed-m', { scale: 'm', shape: 'mixed-flow', flow: 'cold' }, mixedJournal(200),
            '混合流：message/reasoning/tool/interaction/diagnostic/session 全族，投影归约器矩阵每片都碰到。'),
          foldCase('mixed-l', { scale: 'l', shape: 'mixed-flow', flow: 'cold' }, mixedJournal(2_000)),
          foldCase('coverage-disorder', { scale: 'xs', shape: 'coverage', edge: true, flow: 'cold' }, coveragePage(),
            '乱序 + 区间覆盖（#205 覆盖幂等路径）：序列号乱序到达。'),
        ],
      },
      {
        name: 'reduceWorkbenchEvent(live)',
        domain: 'projector',
        wiredAt: 'src/domains/workbench/workbenchProjector.ts:423（经 agentWorkbenchSession.applyLive 每信封调用）',
        note: 'live 单事件续折成本：基文档（s≈1k / m≈10k / l≈40k 行）上的 64 连拍。#440 的每帧 O(N) 热点（整表拷贝、appliedRanges 冻结）都在这一行。',
        cases: [
          liveCase('live-s', { scale: 's', flow: 'growing' }, 501),
          liveCase('live-m', { scale: 'm', flow: 'growing' }, 5_001),
          liveCase('live-l', { scale: 'l', flow: 'growing' }, 20_001, '≈40k 行文档上的单事件折叠（#204③ 同量级会话）。'),
        ],
      },
    ],
  }
}

