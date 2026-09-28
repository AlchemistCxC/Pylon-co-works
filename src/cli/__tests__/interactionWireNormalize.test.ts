import { describe, expect, it } from 'vitest'
import {
  normalizeWireInteractionEntry,
  type InteractionItem,
  type WireInteractionEntry,
} from '../pylonCliService.ts'

/**
 * #423 快照面单源 parity：后端 `interaction_list` 改输出 wire 形状（统一
 * 队列 snapshot 投影），CLI 消费侧经 `normalizeWireInteractionEntry` 重建
 * 旧后端两 store 投影的 `InteractionItem` 形状。期望值迁移自 Rust 侧旧投影
 * 断言（permission.rs `interaction_list_projects_private_interactions_for_cli`
 * 与 `private_interaction_item` 的语义）——wire 收敛不改 CLI 对外表面。
 */

const permissionEntry = (overrides: Partial<WireInteractionEntry> = {}): WireInteractionEntry => ({
  requestId: '7',
  method: 'session/request_permission',
  kind: 'approval',
  sessionId: 's1',
  agentId: 'a1',
  clientGeneration: 2,
  requestedAt: '2026-09-28T10:00:00Z',
  state: 'active',
  provider: 'peri',
  deadlineMs: 1_722_500_300_000,
  payload: {
    provider: 'peri',
    agentId: 'a1',
    sessionId: 's1',
    eventType: 'permission.request',
    requestId: '7',
    toolCallId: 'call-1',
    clientGeneration: 2,
    payload: {
      title: 'tool',
      prompt: 'allow this?',
      options: [
        { optionId: 'allow_once', kind: 'allowOnce', name: 'Allow' },
        { optionId: 'reject_once' },
      ],
      requestedAt: '2026-09-28T10:00:00Z',
      deadlineMs: 1_722_500_300_000,
    },
  },
  ...overrides,
})

describe('normalizeWireInteractionEntry parity (#423)', () => {
  it('permission.request：identity/toolCallId/options 原文透传（含 kind/name）', () => {
    const item = normalizeWireInteractionEntry(permissionEntry())
    expect(item).toEqual({
      provider: 'peri',
      agentId: 'a1',
      kind: 'approval',
      requestId: '7',
      sessionId: 's1',
      toolCallId: 'call-1',
      clientGeneration: 2,
      title: 'tool',
      prompt: 'allow this?',
      options: [
        { optionId: 'allow_once', kind: 'allowOnce', name: 'Allow' },
        { optionId: 'reject_once', kind: null, name: null },
      ],
      requestedAt: '2026-09-28T10:00:00Z',
      deadlineMs: 1_722_500_300_000,
    } satisfies InteractionItem)
  })

  it('permission prompt 保持原文（旧投影不截断；私有桥才截断 400）', () => {
    const long = 'x'.repeat(500)
    const entry = permissionEntry({
      payload: {
        provider: 'peri',
        agentId: 'a1',
        sessionId: 's1',
        eventType: 'permission.request',
        requestId: '7',
        toolCallId: 'call-1',
        clientGeneration: 2,
        payload: {
          title: 'tool',
          prompt: long,
          options: [{ optionId: 'allow_once' }],
          requestedAt: '2026-09-28T10:00:00Z',
          deadlineMs: 1,
        },
      },
    })
    const item = normalizeWireInteractionEntry(entry)
    expect(item?.prompt).toBe(long)
  })

  it('elicitation：虚拟 title/options 白名单、prompt 取 message、toolCallId 空', () => {
    const entry = permissionEntry({
      requestId: '11',
      method: 'elicitation/create',
      kind: 'elicitation',
      clientGeneration: 4,
      provider: 'a1',
      payload: {
        provider: 'a1',
        agentId: 'a1',
        sessionId: 's1',
        eventType: 'elicitation.request',
        requestId: '11',
        clientGeneration: 4,
        payload: { sessionId: 's1', message: 'issue230 验收' },
      },
    })
    const item = normalizeWireInteractionEntry(entry)
    expect(item).toMatchObject({
      kind: 'elicitation',
      title: 'Elicitation',
      prompt: 'issue230 验收',
      toolCallId: '',
      provider: 'a1',
      clientGeneration: 4,
    })
    expect(item?.options.map(option => option.optionId)).toEqual(['accept', 'declined', 'cancel'])
  })

  it('exit_plan：kind=approval + method 区分、planContent 进 prompt、toolCallId 取 params', () => {
    const entry = permissionEntry({
      requestId: 'e2',
      method: '_x.ai/exit_plan_mode',
      kind: 'approval',
      clientGeneration: 5,
      provider: 'peri',
      payload: {
        provider: 'peri',
        agentId: 'a1',
        sessionId: 's1',
        eventType: 'approval.request',
        requestId: 'e2',
        clientGeneration: 5,
        payload: { sessionId: 's1', planContent: 'step 1', toolCallId: 'tc-9' },
      },
    })
    const item = normalizeWireInteractionEntry(entry)
    expect(item).toMatchObject({
      kind: 'approval',
      title: 'Exit plan',
      prompt: 'step 1',
      toolCallId: 'tc-9',
      provider: 'peri',
      clientGeneration: 5,
    })
    expect(item?.options.map(option => option.optionId)).toEqual(['approved', 'abandoned', 'keep_planning'])
  })

  it('ask-user：prompt 为 minted id 摘要（应答 values 的 key）、options 留空', () => {
    const entry = permissionEntry({
      requestId: 'q1',
      method: '_x.ai/ask_user_question',
      kind: 'ask-user',
      payload: {
        provider: 'peri',
        agentId: 'a1',
        sessionId: 's1',
        eventType: 'ask-user',
        requestId: 'q1',
        clientGeneration: 6,
        payload: {
          sessionId: 's1',
          questions: [
            { id: 'question-12', question: 'Pick', header: 'Choice' },
            { id: 'question-13', question: '再选一次' },
          ],
        },
      },
    })
    const item = normalizeWireInteractionEntry(entry)
    expect(item).toMatchObject({
      kind: 'ask-user',
      title: 'Ask user',
      prompt: 'question-12:Pick；question-13:再选一次',
      toolCallId: '',
    })
    expect(item?.options).toEqual([])
  })

  it('ask-user 无回写 id（specs 缺省）→ prompt 回退 method（旧 specs 兜底语义）', () => {
    const entry = permissionEntry({
      requestId: 'q2',
      method: '_x.ai/ask_user_question',
      kind: 'ask-user',
      payload: {
        provider: 'peri',
        agentId: 'a1',
        sessionId: 's1',
        eventType: 'ask-user',
        requestId: 'q2',
        clientGeneration: 6,
        payload: { sessionId: 's1', questions: [{ question: 'No ids' }] },
      },
    })
    const item = normalizeWireInteractionEntry(entry)
    expect(item?.prompt).toBe('_x.ai/ask_user_question')
  })

  it('私有桥 prompt 截断 400 字符（旧 PRIVATE_PROMPT_MAX_CHARS 语义随迁）', () => {
    const long = 'y'.repeat(500)
    const entry = permissionEntry({
      requestId: '12',
      method: 'elicitation/create',
      kind: 'elicitation',
      payload: {
        provider: 'a1',
        agentId: 'a1',
        sessionId: 's1',
        eventType: 'elicitation.request',
        requestId: '12',
        clientGeneration: 4,
        payload: { message: long },
      },
    })
    const item = normalizeWireInteractionEntry(entry)
    expect(item?.prompt).toBe(`${'y'.repeat(400)}…`)
  })

  it('deadlineMs 缺省（wire null）保留 null；未知 eventType 返回 null（不伪造）', () => {
    const entry = permissionEntry({ deadlineMs: null })
    expect(normalizeWireInteractionEntry(entry)?.deadlineMs).toBeNull()
    const unknown = permissionEntry({
      payload: {
        provider: 'x',
        agentId: 'a1',
        sessionId: 's1',
        eventType: 'mystery.request',
        requestId: '9',
        clientGeneration: 1,
        payload: {},
      },
    })
    expect(normalizeWireInteractionEntry(unknown)).toBeNull()
  })

  it('restore 回灌条目：后端已反查回填 provider（空串不出现在 wire 输出）', () => {
    // 后端 interaction_list 对 provider=="" 的条目填 resolve_agent_provider 反查值
    // （回退 agentId）——CLI 只需透传。
    const entry = permissionEntry({ provider: 'a1' })
    expect(normalizeWireInteractionEntry(entry)?.provider).toBe('a1')
  })
})
