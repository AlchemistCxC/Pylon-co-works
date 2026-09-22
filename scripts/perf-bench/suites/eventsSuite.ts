// events 域基准：生产活实现 `normalizeRawEvent`（TS）。
//
// 接线点：`src/domains/events/canonicalNormalizer.ts:196`——每个 wire 帧进前端都要过它
// （`canonicalEventFeed` → cursor → sink 那条链的行归一）。ADR-0018 修订 1 的记载是
// 「events 的 TS 一直就是跑着的那份（`canonicalEventSink.ts` 从未切流）」。
//
// 为什么值得量：单事件成本在**每个** wire 帧上发生，量级 ~µs ⇒ 高事件率下是持续的
// 主线程占用。ADR-0018 修订 1 给过的读数是 ~7.3µs/事件（按 500 事件/s = 单核 0.4%），
// 本基准把这条读数变成可复跑的一列。
//
// 输入面见 `../fixtures/eventWires.ts`：自造形状逐字抄自 `src/__tests__/replay/harness.ts`
// 的 `raw*()`，另接两家真机捕获的载荷。

import type { CanonicalEventOwner, CanonicalNormalizeContext } from '../../../src/domains/events/canonicalNormalizer.ts'
import { normalizeRawEvent } from '../../../src/domains/events/canonicalNormalizer.ts'
import {
  claudeBashLifecycleWires,
  hermesStructuredResultWires,
  hermesToolCardWires,
  malformedWires,
  rawText,
  turnWires,
} from '../fixtures/eventWires.ts'
import type { CaseMeta, PerfCase, PerfSuite } from '../harness.ts'

const OWNER: CanonicalEventOwner = { profileId: 'p1', agentId: 'peri', localSessionId: 'local:bench' }
/** 固定接收时间：把 `Date` 取时排除在读数之外（生产由调用方传入，形状与 `harness.ts` 同）。 */
const RECEIVED_AT = '2026-09-22T00:00:00.000Z'

/** 一段连续助手正文 delta（真实热点：每个 chunk 一帧）。 */
function deltaRun(chunks: number): unknown[] {
  const wires: unknown[] = []
  for (let index = 0; index < chunks; index += 1) wires.push(rawText(`第 ${index} 个增量片段，含中文。`, 'm-delta'))
  return wires
}

/** 真机捕获载荷重复到规模档（两家样本本身就是「工具卡切断 run」的真实字段面）。 */
function capturedCorpus(repeats: number): unknown[] {
  const unit = [...claudeBashLifecycleWires(), ...hermesStructuredResultWires(), ...hermesToolCardWires()]
  const wires: unknown[] = []
  for (let index = 0; index < repeats; index += 1) wires.push(...unit)
  return wires
}

function normalizeCase(id: string, meta: CaseMeta, wires: readonly unknown[], note?: string): PerfCase {
  return {
    id,
    meta,
    units: wires.length,
    unitLabel: '事件',
    ...(note ? { note } : {}),
    run: () => {
      for (let index = 0; index < wires.length; index += 1) {
        const context: CanonicalNormalizeContext = {
          owner: OWNER,
          clientGeneration: 1,
          sequence: index + 1,
          receivedAt: RECEIVED_AT,
        }
        normalizeRawEvent(wires[index], context)
      }
    },
  }
}

export function buildEventsSuite(): PerfSuite {
  return {
    domain: 'events',
    pairs: [
      {
        name: 'normalizeRawEvent',
        domain: 'events',
        wiredAt: 'src/domains/events/canonicalNormalizer.ts:196',
        note: '单帧归一的成本 × 帧数。这一列不含落盘（`canonicalEventSink` 的批事务）与投影（`projector` 域另列）。',
        cases: [
          normalizeCase('delta-run-s', { scale: 's', shape: 'delta' }, deltaRun(500),
            '纯正文 delta 流：最低成本形状，也是最高频的那一种。'),
          normalizeCase('delta-run-m', { scale: 'm', shape: 'delta' }, deltaRun(5_000)),
          normalizeCase('turn-mixed-s', { scale: 's', shape: 'mixed-flow' }, turnWires(40),
            '完整回合混合流（user/思考/markdown/工具卡/状态/终态），并交错两家真机捕获载荷。'),
          normalizeCase('turn-mixed-m', { scale: 'm', shape: 'mixed-flow' }, turnWires(400)),
          normalizeCase('turn-mixed-l', { scale: 'l', shape: 'mixed-flow' }, turnWires(2_000)),
          normalizeCase('captured-real', { scale: 's', shape: 'captured' }, capturedCorpus(50),
            '真机捕获载荷（claude bash 三步 + hermes 结构化结果）：真实字段组合，含蛇形键名与 content 数组。'),
          normalizeCase('malformed', { scale: 'xs', shape: 'malformed', edge: true }, malformedWires(),
            '畸形/非 ACP 载荷：malformed 分支必须与合法载荷一样被计入成本（raw 不丢）。'),
        ],
      },
    ],
  }
}
