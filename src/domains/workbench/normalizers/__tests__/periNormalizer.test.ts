import { describe, expect, it } from 'vitest'
import { normalizePeriEvent } from '../periNormalizer.ts'
import type { NormalizeContext } from '../agentEventNormalizer.ts'

const base: NormalizeContext = {
  provider: 'peri',
  sessionId: 'peri-session',
  sourceId: 'live-1',
  sequence: 1,
  recordedAt: '2026-08-21T00:00:00.000Z',
  provenance: { origin: 'local-observed', trust: 'authoritative' },
  seenEventKeys: new Set(),
}

describe('Peri normalizer', () => {
  it('deduplicates repeated stable identities without dropping the first event', () => {
    const input = { sessionUpdate: 'agent_message_chunk', messageId: 'm-1', content: { type: 'text', text: 'same' } }
    const first = normalizePeriEvent(input, base)
    const second = normalizePeriEvent(input, { ...base, sequence: 2 })
    expect(first.events).toHaveLength(1)
    expect(second.events).toHaveLength(0)
    expect(second.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate.identity', recoverable: true }),
    ]))
  })

  it('keeps unstable events out of the timeline and emits a diagnostic', () => {
    const result = normalizePeriEvent({ sessionUpdate: 'unstable-event', payload: { trace: true } }, { ...base, observe: true })
    expect(result.events[0]?.event.type).not.toBe('event.unknown')
    expect(result.events[0]?.event.type).toBe('diagnostic.notice')
    expect(result.diagnostics[0]).toMatchObject({ code: 'peri.unstable-event', provider: 'peri' })
  })
})

// ── #315 Peri 私有扩展通道（内核包络：判别符 = wire method 原名）─────────────

function extensionInput(update: Record<string, unknown>) {
  return { sessionId: 'peri-session', update }
}

describe('Peri extension channel mapping (#315)', () => {
  it('maps subagent_started/stopped to activity lifecycle', () => {
    const started = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'subagent_started', value: { agent_name: 'scout', instance_id: 'sa-1', is_background: false } }),
    }), base)
    expect(started.events[0]?.event).toMatchObject({
      type: 'activity.started', activityId: 'sa-1',
      activity: { kind: 'subagent', name: 'scout', background: false },
    })

    const stopped = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'subagent_stopped', value: { agent_name: 'scout', result: 'done', is_error: false, instance_id: 'sa-1' } }),
    }), base)
    expect(stopped.events[0]?.event).toMatchObject({ type: 'activity.completed', activityId: 'sa-1' })

    const failed = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'subagent_stopped', value: { agent_name: 'scout', result: 'boom', is_error: true, instance_id: 'sa-1' } }),
    }), base)
    expect(failed.events[0]?.event).toMatchObject({ type: 'activity.failed', error: { message: 'boom' } })
  })

  it('maps compact/rewind/suspend/retry lifecycle variants', () => {
    const compactStarted = normalizePeriEvent(extensionInput({ sessionUpdate: 'peri/agent_event', eventJson: JSON.stringify({ type: 'compact_started' }) }), base)
    expect(compactStarted.events[0]?.event.type).toBe('lifecycle.compact-started')

    const compactDone = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'compact_completed', value: { summary: 'squeezed', strategy: 'smart', trigger: 'auto', files: [{ path: 'a.rs', lines: 3 }] } }),
    }), base)
    expect(compactDone.events[0]?.event).toMatchObject({
      type: 'lifecycle.compact-completed', summary: 'squeezed', strategy: 'smart', trigger: 'auto',
    })

    const rewind = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'rewind_completed', value: { summary: 'back to 3' } }),
    }), base)
    expect(rewind.events[0]?.event).toMatchObject({ type: 'lifecycle.rewind-completed', summary: 'back to 3' })

    const suspended = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'turn_suspended', value: { turn_id: 't-9', agent_id: 'a' } }),
    }), base)
    expect(suspended.events[0]?.event).toMatchObject({ type: 'lifecycle.suspended' })

    const retrying = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'llm_retrying', value: { attempt: 2, max_attempts: 5, delay_ms: 800, error: '429' } }),
    }), base)
    expect(retrying.events[0]?.event).toMatchObject({
      type: 'lifecycle.retrying', attempt: 2, maxAttempts: 5, delayMs: 800, error: '429',
    })
  })

  it('maps context warning to budget.warning and snapshot meta to usage with 0-100 percent', () => {
    const warning = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'context_warning', value: { used_tokens: 90, total_tokens: 100, percentage: 90 } }),
    }), base)
    expect(warning.events[0]?.event).toMatchObject({ type: 'budget.warning', used: 90, limit: 100, percent: 90 })

    const snapshot = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'state_snapshot_meta', value: { message_count: 4, total_tokens: 0, current_step: 2, consecutive_failures: 0, budget_pct: 0.42, context_total_tokens: 200000 } }),
    }), base)
    expect(snapshot.events[0]?.event).toMatchObject({ type: 'usage.updated' })
    const usage = (snapshot.events[0]?.event as { usage?: Record<string, unknown> }).usage
    expect(usage?.contextPercent).toBe(42)
    expect(usage?.contextLimit).toBe(200000)
    expect(usage).not.toHaveProperty('contextUsed')
  })

  it('maps system notifications, oauth flow and agent execution failure', () => {
    const notice = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'system_notification', value: { text: 'mcp up', level: 'warn' } }),
    }), base)
    expect(notice.events[0]?.event).toMatchObject({ type: 'diagnostic.notice', level: 'warning', message: 'mcp up' })

    const needed = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'oauth_needed', value: { server_name: 'gh', auth_url: 'https://auth' } }),
    }), base)
    expect(needed.events[0]?.event).toMatchObject({
      type: 'interaction.requested', interactionId: 'peri-oauth-gh',
      request: { kind: 'oauth', serverName: 'gh', authUrl: 'https://auth' },
    })

    const resolved = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'oauth_completed', value: { server_name: 'gh' } }),
    }), base)
    expect(resolved.events[0]?.event).toMatchObject({ type: 'interaction.resolved', interactionId: 'peri-oauth-gh' })

    const failed = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'agent_execution_failed', value: { message: 'executor died' } }),
    }), base)
    expect(failed.events[0]?.event).toMatchObject({ type: 'diagnostic.notice', level: 'error', code: 'peri.agent-execution-failed' })
  })

  it('maps workflow/background/lsp variants to activity and diagnostic surfaces', () => {
    const workflow = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'workflow_progress', value: { run_id: 'wf-1', workflow_name: 'ship', event_type: 'phase', phase: 'build' } }),
    }), base)
    expect(workflow.events[0]?.event).toMatchObject({ type: 'activity.progress', activityId: 'wf-1' })

    const bg = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'background_task_completed', value: { task_id: 'bt-2', agent_name: 'nightly', success: true, output: 'ok', tool_calls_count: 3, duration_ms: 1200 } }),
    }), base)
    expect(bg.events[0]?.event).toMatchObject({ type: 'activity.completed', activityId: 'bt-2' })

    const lsp = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'lsp_diagnostics', value: { errors: 1, warnings: 2, files_with_errors: 1 } }),
    }), base)
    expect(lsp.events[0]?.event.type).toBe('diagnostic.updated')
  })

  it('maps prediction_ready to assist.prediction', () => {
    const result = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/prediction_ready',
      text: 'npm run b',
      actions: [{ type: 'placeholder', text: 'npm run build' }],
    }), base)
    expect(result.events[0]?.event).toMatchObject({
      type: 'assist.prediction', placeholder: 'npm run b',
      actions: [{ type: 'placeholder', text: 'npm run build' }],
    })
  })

  it('never maps peri/agent_event_done to session.completed (kernel ledger owns terminal)', () => {
    const result = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event_done',
      stopReason: 'end_turn',
      requestId: '42',
    }), base)
    expect(result.events[0]?.event.type).toBe('diagnostic.notice')
    expect(result.events[0]?.event).toMatchObject({ code: 'peri.turn-done', data: { stopReason: 'end_turn', requestId: '42' } })
    expect(result.events.some(event => event.event.type === 'session.completed')).toBe(false)
  })

  it('falls back to event.unknown with raw retained for malformed/unknown payloads', () => {
    const malformed = normalizePeriEvent(extensionInput({ sessionUpdate: 'peri/agent_event', eventJson: '{not-json' }), base)
    expect(malformed.events[0]?.event.type).toBe('event.unknown')
    expect(malformed.diagnostics[0]).toMatchObject({ code: 'peri.agent-event-malformed' })

    const unknown = normalizePeriEvent(extensionInput({
      sessionUpdate: 'peri/agent_event',
      eventJson: JSON.stringify({ type: 'brand_new_variant', value: { x: 1 } }),
    }), base)
    expect(unknown.events[0]?.event).toMatchObject({ type: 'event.unknown', originalType: 'brand_new_variant', raw: { x: 1 } })
    expect(unknown.diagnostics[0]).toMatchObject({ code: 'peri.agent-event-unknown' })
  })
})
