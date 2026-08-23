import { describe, expect, it } from 'vitest'
import { createWorkbenchEnvelope } from '../events/workbenchEventSchema.ts'
import { projectWorkbench, reduceWorkbenchEvent, selectInteractions, selectPendingInteractions } from '../workbenchProjector.ts'

/**
 * C11 RED：interaction.approval/questions/confirm/permission 投影契约（DIC-C11-01）。
 *
 * - InteractionRequest 结构化承载 id/kind/prompt/options/capability/expiry/status；
 * - projector 维护 pending/resolved/expired；重复 response 幂等；
 * - renderer 只读 normalized request，不读 vendor payload。
 */

const envelope = (sequence: number, event: Parameters<typeof createWorkbenchEnvelope>[0]['event']) =>
  createWorkbenchEnvelope({
    sessionId: 'session-c11',
    sequence,
    recordedAt: `2026-08-23T08:00:0${sequence}.000Z`,
    source: { provider: 'claude', sourceId: `c11-${sequence}` },
    identity: {},
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event,
  })

describe('C11 interaction projection', () => {
  it('narrows a permission request into structured fields and resolves it exactly once', () => {
    const events = [
      envelope(1, {
        type: 'interaction.requested', interactionId: 'int-1',
        request: {
          kind: 'permission', prompt: 'Allow rm -rf in workspace?',
          capability: 'fs.write', danger: true,
          options: [
            { id: 'allow', label: '允许' },
            { id: 'allow-once', label: '仅本次' },
            { id: 'deny', label: '拒绝' },
          ],
          expiry: '2026-08-23T09:00:00.000Z',
        },
      }),
      envelope(2, {
        type: 'interaction.resolved', interactionId: 'int-1',
        response: { optionId: 'deny' },
      }),
      // 重复 response：幂等拒绝——状态与首个 response 不被改写
      envelope(3, {
        type: 'interaction.resolved', interactionId: 'int-1',
        response: { optionId: 'allow' },
      }),
    ]
    const { document } = projectWorkbench(events)
    const list = selectInteractions(document)
    expect(list).toHaveLength(1)
    const interaction = list[0]
    expect(interaction.status).toBe('resolved')
    expect(interaction.request).toMatchObject({ kind: 'permission', danger: true })
    expect((interaction.response as { optionId: string }).optionId).toBe('deny')
  })

  it('keeps an expired interaction distinguishable and preserves its reason', () => {
    const { document } = projectWorkbench([
      envelope(1, {
        type: 'interaction.requested', interactionId: 'int-2',
        request: { kind: 'approval', prompt: 'Deploy to production?' },
      }),
      envelope(2, {
        type: 'interaction.expired', interactionId: 'int-2', reason: 'ttl elapsed',
      }),
    ])
    const interaction = selectInteractions(document)[0]
    expect(interaction.status).toBe('expired')
    expect(interaction.reason).toBe('ttl elapsed')
  })

  it('keeps live apply and restart replay deeply equal while pending selectors remain stable', () => {
    const requested = envelope(1, {
      type: 'interaction.requested', interactionId: 'int-live-replay',
      request: {
        surface: 'interaction', kind: 'questions', state: 'waiting',
        identity: { provider: 'claude', agentId: 'agent', requestId: 'req', sessionId: 'session-c11', clientGeneration: 4 },
        questions: [{ id: 'scope', question: '选择范围', allowMultiple: true, allowFreeform: true,
          options: [{ id: 'repo', label: '仓库' }] }],
      },
    })
    const expired = envelope(2, { type: 'interaction.expired', interactionId: 'int-live-replay', reason: 'ttl elapsed' })
    const live = reduceWorkbenchEvent(projectWorkbench([requested]).document, expired)
    const replay = projectWorkbench([expired, requested]).document
    expect(live).toEqual(replay)
    expect(selectInteractions(live)).toHaveLength(1)
    expect(selectPendingInteractions(live)).toEqual([])
    expect(selectInteractions(live)[0]).toMatchObject({ status: 'expired', reason: 'ttl elapsed', request: { kind: 'questions' } })
  })
})
