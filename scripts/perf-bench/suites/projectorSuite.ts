// projector 域基准：生产活实现 `projectWorkbench`（TS，ADR-0018 修订 1 回退后的唯一实现）。
//
// 接线点：`src/domains/workbench/workbenchProjector.ts:444`；工作台会话在冷重放/刷新时调它。
// 输入面 `../fixtures/envelopes.ts` 从 git 历史恢复（出处见该文件头注）。
//
// 为什么这是「已接线」而不是「已回退所以不用量」：回退改的是**实现语言**，不是这条路径的存在。
// 投影每次冷重放都要跑，它的绝对成本与事件数成正比——正是最该有基准看着的那类开销点。

import { projectWorkbench } from '../../../src/domains/workbench/workbenchProjector.ts'
import { coveragePage, deltaJournal, mixedJournal } from '../fixtures/envelopes.ts'
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
    ],
  }
}
