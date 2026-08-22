import { describe, expect, it } from 'vitest'
import { BUILTIN_LIFECYCLE_RENDER_KINDS } from '../builtinRenderContent.ts'

describe('C13 lifecycle and system render kinds', () => {
  it('publishes semantic kinds and the declared lifecycle appearance controls', () => {
    expect(BUILTIN_LIFECYCLE_RENDER_KINDS.map(kind => kind.id)).toEqual([
      'lifecycle.retry', 'lifecycle.compact', 'lifecycle.rewind', 'lifecycle.suspended', 'lifecycle.recovered',
      'system.notice', 'system.error',
    ])

    for (const kind of BUILTIN_LIFECYCLE_RENDER_KINDS) {
      const fields = kind.settings?.groups.flatMap(group => group.fields).map(field => field.key)
      expect(kind.settings?.schemaVersion).toBe(kind.settingsSchemaVersion)
      expect(kind.validateInput(kind.fixture), `${kind.id} fixture must satisfy its renderer boundary`).toBe(true)
      expect(fields).toEqual(expect.arrayContaining([
        'foreground', 'mutedForeground', 'background', 'borderColor',
        'infoColor', 'warningColor', 'errorColor', 'successColor',
        'density', 'technicalDetailsExpanded', 'noticePlacements', 'retryCountdownStyle',
        'showProviderIds', 'showEventIds', 'motion',
      ]))
    }
  })

  it('accepts projected lifecycle/error/notice payloads and rejects provider raw', () => {
    const kinds = new Map(BUILTIN_LIFECYCLE_RENDER_KINDS.map(kind => [kind.id, kind]))
    const state = {
      retry: {
        attempt: 2, maxAttempts: 3, delayMs: 1000,
        error: { userSummary: 'Provider 过载', technicalMessage: '429', recoverability: 'retry', metadata: { retryAfter: 1 } },
      },
      history: [{ kind: 'retry', attempt: 2, maxAttempts: 3 }],
    }
    expect(kinds.get('lifecycle.retry')!.validateInput(state)).toBe(true)
    expect(kinds.get('lifecycle.retry')!.validateInput({ type: 'lifecycle.retrying', attempt: 2 })).toBe(false)
    expect(kinds.get('system.error')!.validateInput({
      userSummary: 'Renderer 失败', technicalMessage: 'mount threw', code: 'renderer.mount.failed',
      rendererSuiteId: 'builtin.solid', rendererSlotId: 'slot-a', phase: 'mount', recoverability: 'reload-plugin',
    })).toBe(true)
    expect(kinds.get('system.error')!.validateInput({ message: 'provider raw error', retryable: true })).toBe(false)
    expect(kinds.get('system.notice')!.validateInput({
      code: 'compact.complete', message: '压缩完成', eventId: 'event-1', sequence: 3, level: 'info', data: { safe: true },
    })).toBe(true)
    expect(kinds.get('system.notice')!.validateInput({ providerEvent: { message: 'raw' } })).toBe(false)
  })
})
