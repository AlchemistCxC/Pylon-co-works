/**
 * #81 L1：canonicalRowToWorkbench 的 batch 行展开测试。
 * - batch 行按 seqSpan 展开重建 sub-envelope（eventId = owner#(seqSpan[0]+i)）⇒
 *   appliedEventIds 与逐 chunk 存储逐一相同、文档逐字节相等；
 * - live 路径（sink 发布合并行）与逐 chunk 发布的文档一致；
 * - 形状损坏的 batch 行退回单行归一（event.unknown，raw 不丢，不崩溃）。
 */
import { describe, expect, it } from 'vitest'
import { normalizeRawEvent } from '../../../domains/events/canonicalNormalizer'
import { mergeAdjacentDeltaChunks } from '../../../infrastructure/events/canonicalEventBatch'
import { toCanonicalOwnerKey, type CanonicalConversationEvent, type CanonicalEventOwner } from '../../../domains/events/eventSchema'
import type { Session } from '../../../identityStore.ts'
import { createAgentWorkbenchSessionRuntime } from '../agentWorkbenchSession.ts'

const owner: CanonicalEventOwner = { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }
const ownerKey = toCanonicalOwnerKey(owner)

function session(id = 'session-batch'): Session {
  return {
    id, source: 'local:a', agentId: 'peri', profileId: 'profile-a', name: id,
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function rawText(text: string, messageId = 'msg-1'): unknown {
  return {
    source: 'local:a',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId },
  }
}

function rawThinking(text: string, messageId = 'msg-1'): unknown {
  return {
    source: 'local:a',
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text }, messageId },
  }
}

function rawUser(text: string): unknown {
  return { source: 'local:a', update: { sessionUpdate: 'user_message_chunk', content: { text } } }
}

function rawToolStart(toolCallId: string): unknown {
  return {
    source: 'local:a',
    update: { sessionUpdate: 'tool_call', toolCallId, title: 'Read', kind: 'read' },
  }
}

function rawDone(): unknown {
  return { source: 'local:a', update: { sessionUpdate: 'done' } }
}

/** 逐 chunk canonical 行（每行 receivedAt 互不相同，等价性不得依赖时间戳巧合）。 */
function chunkRows(wires: readonly unknown[]): CanonicalConversationEvent[] {
  return wires.map((raw, index) => normalizeRawEvent(raw, {
    owner,
    clientGeneration: 1,
    sequence: index + 1,
    receivedAt: new Date(Date.UTC(2026, 8, 14, 0, 0, 0) + index).toISOString(),
  }).event)
}

async function bindWith(rows: readonly unknown[]) {
  const service = createAgentWorkbenchSessionRuntime({
    loadAll: async () => rows,
    subscribe: () => () => {},
  })
  await service.bind(session())
  const snapshot = service.runtime.getSnapshot()
  service.destroy()
  return snapshot
}

describe('agentWorkbenchSession batch 展开（#81 L1）', () => {
  it('replay：batch 行展开的 appliedEventIds 与文档和逐 chunk 存储逐字节一致', async () => {
    const wires = [
      rawUser('问题'),
      rawThinking('思考'),
      rawThinking('中'),
      rawText('答'),
      rawText('案'),
      rawToolStart('tool-1'),
      rawText('完成'),
      rawDone(),
    ]
    const perChunk = chunkRows(wires)
    const merged = mergeAdjacentDeltaChunks(perChunk)
    expect(merged.length).toBeLessThan(perChunk.length)

    const fromChunks = await bindWith(perChunk)
    const fromBatch = await bindWith(merged)

    expect(JSON.stringify(fromBatch.document)).toBe(JSON.stringify(fromChunks.document))
    expect(fromBatch.document?.appliedEventIds).toEqual(fromChunks.document?.appliedEventIds)
    // 跨度中间编号按 seqSpan 重建为原始 id：owner#1..owner#8
    expect(fromBatch.document?.appliedEventIds).toEqual(perChunk.map(row => `${ownerKey}#${row.sequence}`))
  })

  it('live：sink 发布的合并行经订阅展开后，文档与逐 chunk 发布一致', async () => {
    const wires = [rawText('你'), rawText('好'), rawText('世界')]
    const perChunk = chunkRows(wires)
    const [batch] = mergeAdjacentDeltaChunks(perChunk)

    const buildLive = async (events: readonly unknown[]) => {
      let publish: ((event: unknown) => void) | undefined
      const service = createAgentWorkbenchSessionRuntime({
        loadAll: async () => [],
        subscribe: listener => { publish = listener; return () => { publish = undefined } },
      })
      await service.bind(session())
      for (const event of events) publish?.(event)
      const snapshot = service.runtime.getSnapshot()
      service.destroy()
      return snapshot
    }

    const fromChunks = await buildLive(perChunk)
    const fromBatch = await buildLive([batch])
    expect(JSON.stringify(fromBatch.document)).toBe(JSON.stringify(fromChunks.document))
    expect(fromBatch.document?.messages.some(message => message.role === 'assistant' && message.content === '你好世界')).toBe(true)
  })

  it('形状损坏的 batch 行退回单行归一：产出 unknown 信封且不崩溃', async () => {
    const corrupt: CanonicalConversationEvent = {
      ...chunkRows([rawText('a'), rawText('b')]).map(row => row)[0],
      eventType: 'assistant.text.delta.batch',
      typedPayload: { text: 'ab', foldedCount: 2, seqSpan: [1, 2] },
      rawPayload: [rawText('a')], // 长度与 foldedCount/seqSpan 不互洽
    }
    const snapshot = await bindWith([rawUser('q') as unknown, corrupt, rawDone() as unknown].slice(0, 2))
    expect(snapshot.document?.diagnostics.some(item => item.code === 'canonical.journal.malformed')).toBe(true)
    expect(snapshot.status).toBe('degraded')
  })
})
