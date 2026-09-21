/**
 * 文档层不变量：把等价性从 `Message[]` 上提到**真正被渲染的那一层**。
 *
 * 前面的套件都停在 `projectMessagesFromCanonical`（纯投影）。但渲染读的是
 * workbench document：它除了消息，还带 `appliedEventIds` 与由 coverage 区间驱动的
 * **互斥去重**——"同一 sequence 不得被重复投影"这条在文档层才真正落地。
 *
 * 因此本文件用同一段会话的多种存储形态分别 **bind** 一份会话运行时，比较最终文档。
 * 这一层若不等价，前几层的等价就只是"上游一致"，与用户看到什么无关。
 *
 * 已知不覆盖：**live 路径**（帧经 Channel 到达 → applyLive → 文档）与 load 期间的
 * buffer 折入。本文件走的是 canonical 读（bind → loadAll → 投影），即"冷读/切页重绑"
 * 那条路；live 路径需要另建 harness，见 spec 的 F2/F3。
 */
import { describe, expect, it } from 'vitest'
import type { Session } from '../../identityStore.ts'
import { createAgentWorkbenchSessionRuntime } from '../../sheets/agent-workbench/agentWorkbenchSession.ts'
import { mergeAdjacentDeltaChunks } from '../../infrastructure/events/canonicalEventBatch.ts'
import type { CanonicalConversationEvent } from '../../domains/events/eventSchema.ts'
import { REAL_FIXTURE_SCENARIOS } from './realFixtures.ts'
import { SCENARIOS, toUnitRows } from './fixtures.ts'
import { chunkRows } from './harness.ts'

const ACTIVE: Session = {
  id: 'session-doc', source: 'local:s1', agentId: 'peri', profileId: 'p1', name: 'doc',
  createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
  skills: [], hooks: [], autoName: '',
}

/** 用给定行集 bind 一份会话运行时，返回最终文档的可比较快照。 */
async function documentOf(rows: readonly CanonicalConversationEvent[]) {
  const runtime = createAgentWorkbenchSessionRuntime({
    loadAll: async () => rows,
    subscribe: () => () => {},
    listenTerminalFallback: () => () => {},
    commands: {
      resolveSession: () => ACTIVE,
      nextClientMessageId: () => 'client-doc-1',
      sendMessage: async () => {},
      optimisticUser: () => {},
      rejectOptimisticUser: () => {},
      resolvePersona: () => 'default',
      requestCancel: () => {},
    },
  })
  await runtime.bind(ACTIVE)
  const document = runtime.runtime.getSnapshot().document
  expect(document, 'bind 后必须有文档').toBeTruthy()
  const snapshot = {
    messages: document!.messages.map(message => ({ role: message.role, content: message.content })),
    appliedEventIds: [...document!.appliedEventIds],
    appliedRanges: document!.appliedRanges.map(range => [range[0], range[1]] as readonly [number, number]),
    timeline: document!.timeline.map(entry => ({ sequence: entry.sequence, eventId: entry.eventId, kind: entry.kind })),
  }
  runtime.destroy()
  return snapshot
}

const SCENARIOS_UNDER_TEST = [...SCENARIOS.slice(0, 4), ...REAL_FIXTURE_SCENARIOS.slice(0, 2)]

describe('文档层 · 多种存储形态 bind 出同一份文档', () => {
  for (const scenario of SCENARIOS_UNDER_TEST) {
    it(`逐 chunk / 聚合 / 单元混合 三种形态文档一致：${scenario.name}`, async () => {
      const perChunk = chunkRows(scenario.wires)
      const expected = await documentOf(perChunk)

      // #226：聚合形态按段级展开——消息面/appliedRanges/appliedEventIds 与逐 chunk 一致；
      // timeline 按聚合行粒度收缩（每条聚合行一个条目，sequence=跨度末位，kind 与逐
      // chunk 展开在同一 sequence 上的条目一致）。eventId/条目数不再逐字节相等，此即
      // #226 的目的（信封数随折叠比下降）。
      const mergedRows = mergeAdjacentDeltaChunks(perChunk)
      const batch = await documentOf(mergedRows)
      expect(batch.messages, '聚合形态消息面').toEqual(expected.messages)
      expect(batch.appliedRanges, '聚合形态 appliedRanges').toEqual(expected.appliedRanges)
      expect(batch.appliedEventIds, '聚合形态 appliedEventIds').toEqual(expected.appliedEventIds)
      const chunkKindBySequence = new Map(expected.timeline.map(entry => [entry.sequence, entry.kind]))
      expect(batch.timeline.map(entry => ({ sequence: entry.sequence, kind: entry.kind })), '聚合形态 timeline 跨度对应')
        .toEqual(mergedRows.map(row => ({ sequence: row.sequence, kind: chunkKindBySequence.get(row.sequence) })))

      expect(await documentOf(toUnitRows(perChunk, { keepCovered: true })), '单元未裁剪混合形态').toEqual(expected)
    })

    it(`单元已裁剪形态不丢正文（appliedEventIds 允许不同，消息必须相同）：${scenario.name}`, async () => {
      const perChunk = chunkRows(scenario.wires)
      const expected = await documentOf(perChunk)
      const trimmed = await documentOf(toUnitRows(perChunk, { keepCovered: false }))
      expect(trimmed.messages).toEqual(expected.messages)
    })
  }
})

describe('文档层 · 同一 sequence 不得被重复投影（collision 计数）', () => {
  for (const scenario of SCENARIOS_UNDER_TEST) {
    it(`appliedEventIds 无重复且覆盖 [1..revision]：${scenario.name}`, async () => {
      const perChunk = chunkRows(scenario.wires)
      const document = await documentOf(perChunk)
      expect(new Set(document.appliedEventIds).size, 'appliedEventIds 出现重复').toBe(document.appliedEventIds.length)
      // 时间线条目同样不得重复（timeline 是文档层的第二条记录）
      expect(new Set(document.timeline).size, 'timeline 出现重复').toBe(document.timeline.length)
      expect(document.timeline.length).toBe(perChunk.length)
    })
  }
})
