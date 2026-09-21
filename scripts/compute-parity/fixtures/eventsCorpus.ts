// events 域语料构建器：wire 形态 → canonical 行（与 eventsComputeParity.test.ts
// 同构；宿主策略列同表）。供 `scripts/compute-parity/` 的 events 套件生成
// shape/edge/scale 各档输入。

import { normalizeRawEvent, type CanonicalNormalizeContext } from '../../../src/domains/events/canonicalNormalizer.ts'
import { createCanonicalEvent, type CanonicalConversationEvent, type CanonicalEventOwner } from '../../../src/domains/events/eventSchema.ts'
import type { HostColumns } from './eventsFrame.ts'

export const owner: CanonicalEventOwner = { profileId: 'p1', agentId: 'peri', localSessionId: 'local:s1' }
export const BASE_MS = Date.UTC(2026, 8, 14, 0, 0, 0)

export function isoAt(ms: number): string {
  return new Date(ms).toISOString()
}

export function context(sequence: number, clientGeneration = 1): CanonicalNormalizeContext {
  return { owner, clientGeneration, sequence, receivedAt: isoAt(BASE_MS + sequence) }
}

export function rawText(text: string, messageId = 'msg-1'): unknown {
  return {
    source: 'local:s1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId },
  }
}

export function rawThinking(text: string, messageId = 'msg-1'): unknown {
  return {
    source: 'local:s1',
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text }, messageId },
  }
}

export function rawUser(text: string): unknown {
  return { source: 'local:s1', update: { sessionUpdate: 'user_message_chunk', content: { text } } }
}

export function rawToolStart(toolCallId: string, extra: Record<string, unknown> = {}): unknown {
  return {
    source: 'local:s1',
    update: { sessionUpdate: 'tool_call', toolCallId, title: 'Read', kind: 'read', ...extra },
  }
}

export function rawToolUpdate(toolCallId: string, extra: Record<string, unknown> = {}): unknown {
  return {
    source: 'local:s1',
    update: { sessionUpdate: 'tool_call_update', toolCallId, ...extra },
  }
}

export function rawDone(): unknown {
  return { source: 'local:s1', update: { sessionUpdate: 'done' } }
}

export function chunkRows(wires: readonly unknown[], clientGeneration = 1): CanonicalConversationEvent[] {
  return wires.map((raw, index) => normalizeRawEvent(raw, context(index + 1, clientGeneration)).event)
}

/** 一轮「用户提问 → thinking → 文本流 → 工具 → 完成」的典型对话 wire 序列。 */
export function conversationTurn(turnIndex: number, options: { textChunks?: number } = {}): unknown[] {
  const chunks = options.textChunks ?? 3
  const wires: unknown[] = [
    rawUser(`问题 ${turnIndex}`),
    rawThinking(`思考 ${turnIndex}-a`),
    rawThinking(`思考 ${turnIndex}-b`),
  ]
  for (let index = 0; index < chunks; index += 1) wires.push(rawText(`答案${turnIndex}-${index} `, `msg-t${turnIndex}`))
  wires.push(rawToolStart(`tool-t${turnIndex}`, { rawInput: { path: `f${turnIndex}.txt` } }))
  wires.push(rawToolUpdate(`tool-t${turnIndex}`, { status: 'completed', rawOutput: { ok: true } }))
  wires.push(rawDone())
  return wires
}

export const columns: HostColumns = {
  timeLabel: event => `@${String(event.receivedAt ?? '')}`,
  toolInputSummary: (title, rawInput) => (title === 'Read' ? `READ:${JSON.stringify(rawInput)}` : ''),
}

/** 恒等注入列：单元展开的段事件在 wasm 内合成、无宿主格式化列。 */
export const identityColumns: HostColumns = {
  timeLabel: event => String(event.receivedAt ?? ''),
  toolInputSummary: (title, rawInput) => (title === 'Read' ? `READ:${JSON.stringify(rawInput)}` : ''),
}
