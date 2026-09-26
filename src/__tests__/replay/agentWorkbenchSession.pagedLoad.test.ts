// @vitest-environment jsdom
/**
 * #376-b：分页冷装载与一次性冷装载的**文档等价**。
 *
 * 生产路径（`listJournalPages` 缺省实现）按页取 compact 读并逐页续折，装载期不再
 * 「整库行 + 整库信封 + 文档」三份并存。装载机制换了，终态文档必须一模一样——
 * 本文件是那条等价性的守卫，范式沿用同目录 `agentWorkbenchSession.batch.test.ts`
 * 的 `bindWith` + 消息面比较。
 *
 * 页边界由 Rust 侧保证落在 delta run 边界上（见 `event_repo::fold::continues_run` 与
 * `load_events_compact_page`），故这里的分页替身也按 run 边界切；同时补一条「硬切进
 * run 中间」的健壮性断言：内容面仍然等价，只是 batch 行切分粒度变细。
 */
import { describe, expect, it } from 'vitest'
import { normalizeRawEvent } from '../../domains/events/canonicalNormalizer'
import { mergeAdjacentDeltaChunks } from '../../infrastructure/events/canonicalEventBatch'
import { toCanonicalOwnerKey, type CanonicalConversationEvent, type CanonicalEventOwner } from '../../domains/events/eventSchema'
import type { Session } from '../../domains/identity/identityStore.ts'
import type { WorkbenchDocument } from '../../domains/workbench/workbenchProjector.ts'
import type { CanonicalEventRow } from '../../infrastructure/events/canonicalEventRepository.ts'
import { createAgentWorkbenchSessionRuntime } from '../../sheets/agent-workbench/agentWorkbenchSession.ts'

const owner: CanonicalEventOwner = { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }
const ownerKey = toCanonicalOwnerKey(owner)

function session(id = 'session-paged'): Session {
  return {
    id, source: 'local:a', agentId: 'peri', profileId: 'profile-a', name: id,
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function rawText(text: string, messageId = 'msg-1'): unknown {
  return { source: 'local:a', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId } }
}

function rawUser(text: string): unknown {
  return { source: 'local:a', update: { sessionUpdate: 'user_message_chunk', content: { text } } }
}

function rawToolStart(toolCallId: string): unknown {
  return { source: 'local:a', update: { sessionUpdate: 'tool_call', toolCallId, title: 'Read', kind: 'read' } }
}

function rawDone(): unknown {
  return { source: 'local:a', update: { sessionUpdate: 'done' } }
}

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

/**
 * 分页装载替身：把同一份行按给定页边界逐页喂给宿主。刻意**不**给 `loadAll`——
 * 只给分页缝，默认分页读才会启用，走的才是生产代码路径。
 */
async function bindPaged(rows: readonly unknown[], pageSizes: readonly number[]) {
  const service = createAgentWorkbenchSessionRuntime({
    listJournalPages: async (_ownerKey, onPage) => {
      let cursor = 0
      for (const size of pageSizes) {
        if (cursor >= rows.length) break
        const slice = rows.slice(cursor, cursor + size) as readonly CanonicalEventRow[]
        cursor += size
        await onPage(slice, cursor >= rows.length)
      }
      if (cursor < rows.length) await onPage(rows.slice(cursor) as readonly CanonicalEventRow[], true)
      if (rows.length === 0) await onPage([], true)
    },
    subscribe: () => () => {},
  })
  await service.bind(session())
  const snapshot = service.runtime.getSnapshot()
  service.destroy()
  return snapshot
}

/** 文档里与「读出来什么」有关的全部面（不含渲染键与冻结细节）。 */
function documentShape(document: WorkbenchDocument | undefined) {
  if (!document) return undefined
  return {
    revision: document.revision,
    appliedEventIds: document.appliedEventIds,
    appliedRanges: document.appliedRanges,
    messages: document.messages.map(message => ({
      role: message.role, content: message.content, identity: message.identity,
      sequence: message.sequence, running: message.running, time: message.time,
    })),
    activities: document.activities,
    interactions: document.interactions,
    diagnostics: document.diagnostics,
    timeline: document.timeline.map(entry => ({ sequence: entry.sequence, kind: entry.kind, eventId: entry.eventId })),
    session: { model: document.session.model, mode: document.session.mode, options: document.session.options, commands: document.session.commands },
  }
}

function comparableMessages(document: WorkbenchDocument | undefined) {
  return document?.messages.map(message => ({ role: message.role, content: message.content, sequence: message.sequence }))
}

/** 一个完整回合的 compact 读结果：user 行 +（被 unit 覆盖的 delta 段）+ unit + 未覆盖尾部 run。 */
function compactRows(): { rows: CanonicalEventRow[]; all: CanonicalConversationEvent[] } {
  const firstTurn = chunkRows([rawUser('问题'), rawText('答'), rawText('案'), rawToolStart('tool-1'), rawDone()])
  const unit = {
    ...firstTurn[4],
    eventId: `${ownerKey}#6`,
    sequence: 6,
    eventType: 'turn.unit' as const,
    typedPayload: {
      aggregateKind: 'turn-rollup',
      seqStart: 1,
      seqEnd: 5,
      foldedCount: 5,
      terminal: { eventType: 'turn.completed', occurredAt: firstTurn[4].occurredAt },
      segments: [
        { kind: 'event', event: firstTurn[0] },
        { kind: 'delta-run', eventType: 'assistant.text.delta', seqStart: 2, seqEnd: 3, identity: { messageId: 'msg-1' }, text: '答案', occurredAt: firstTurn[1].occurredAt, markdown: false },
        { kind: 'event', event: firstTurn[3] },
        { kind: 'event', event: firstTurn[4] },
      ],
    },
    rawPayload: { kind: 'turn-unit' },
  } as unknown as CanonicalEventRow
  const tailWires = [rawUser('二问'), rawText('甲'), rawText('乙'), rawText('丙')]
  const tail = tailWires.map((raw, index) => normalizeRawEvent(raw, {
    owner, clientGeneration: 1, sequence: 7 + index,
    receivedAt: new Date(Date.UTC(2026, 8, 14, 0, 1, 0) + index).toISOString(),
  }).event)
  const foldedTail = mergeAdjacentDeltaChunks(tail)
  return {
    rows: [firstTurn[0], unit, ...foldedTail] as unknown as CanonicalEventRow[],
    all: [...firstTurn, ...tail],
  }
}

describe('#376-b 分页冷装载等价性', () => {
  it('页边界落在 run 边界上时，分页装载与一次性装载的文档逐字段相同', async () => {
    const { rows } = compactRows()
    const oneShot = await bindWith(rows)
    // 每页一行：把页切得最碎（若页边界对齐 run，切多碎都不该改变终态）
    const paged = await bindPaged(rows, rows.map(() => 1))
    expect(documentShape(paged.document)).toEqual(documentShape(oneShot.document))
    expect(paged.summary).toEqual(oneShot.summary)
  })

  it('多页尺寸组合（含空尾页）同样收敛到同一文档', async () => {
    const { rows } = compactRows()
    const oneShot = await bindWith(rows)
    for (const sizes of [[1, 2, 1, 5], [3, 3, 3, 3], [100], [2, 100]]) {
      const paged = await bindPaged(rows, sizes)
      expect(documentShape(paged.document), `页尺寸 ${sizes.join(',')}`).toEqual(documentShape(oneShot.document))
    }
  })

  it('页边界硬切进 delta run 中间时内容面仍等价（Rust 侧本不会这样切）', async () => {
    const { rows } = compactRows()
    const oneShot = await bindWith(rows)
    // 逐行切会把尾部 run 切碎——内容（消息正文/顺序）必须仍然等价。
    const paged = await bindPaged(rows, [1, 1, 1, 1, 1, 1])
    expect(comparableMessages(paged.document)).toEqual(comparableMessages(oneShot.document))
  })

  it('空 journal 只发一页空页，装载正常收尾', async () => {
    const empty = await bindPaged([], [])
    const oneShot = await bindWith([])
    expect(documentShape(empty.document)).toEqual(documentShape(oneShot.document))
    expect(empty.status).toBe('ready')
  })
})
